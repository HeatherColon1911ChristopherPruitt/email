// 收件处理。Cloudflare Email Routing 把整封原始邮件交进来，这里解析、清洗、入库。
import PostalMime, { decodeWords } from 'postal-mime';
import { extractCode } from './extract.js';
import { htmlToText, rewriteCidImages, sanitizeHtml } from './html.js';
import { ensureSchema, insertImages, insertMessage } from './db.js';
import { LIMITS, isLocalAddress, normalizeAddress, readConfig } from './config.js';

function randomToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBytes(content) {
	if (content instanceof Uint8Array) return content;
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	return new Uint8Array(0);
}

// 超大邮件不解析正文，但仍然能从头部拿到主题，让占位记录可辨认。
function readHeaderSubject(message) {
	try {
		const raw = message.headers?.get('subject') || '';
		if (!raw) return '';
		// 邮件头里的中文是 =?UTF-8?B?...?= 编码，直接用会显示成乱码
		return String(decodeWords(raw)).slice(0, 500);
	} catch {
		return '';
	}
}

function pickInlineImages(parsed, token) {
	const images = [];
	const urlByCid = new Map();
	let budget = 0;

	for (const attachment of parsed.attachments || []) {
		if (images.length >= LIMITS.maxImages) break;
		if (!attachment.contentId) continue;
		if (attachment.disposition === 'attachment') continue;

		const contentType = String(attachment.mimeType || '').toLowerCase();
		if (!contentType.startsWith('image/')) continue;

		const bytes = toBytes(attachment.content);
		if (!bytes.byteLength || bytes.byteLength > LIMITS.maxImageBytes) continue;
		if (budget + bytes.byteLength > LIMITS.maxImageBytes * 4) break;

		const seq = images.length + 1;
		images.push({ seq, contentType, byteSize: bytes.byteLength, body: bytes });
		budget += bytes.byteLength;

		const cid = String(attachment.contentId)
			.trim()
			.replace(/^<|>$/g, '');
		if (!cid) continue;
		const url = `/i/${token}/${seq}`;
		urlByCid.set(cid, url);
		urlByCid.set(cid.toLowerCase(), url);
	}

	return { images, urlByCid };
}

export async function handleIncoming(message, env) {
	const config = readConfig(env);
	const address = normalizeAddress(message.to);

	// 理论上 Email Routing 只会把本域名邮件送进来，这里再挡一次，避免配置串域。
	if (!address || !isLocalAddress(address, config)) {
		message.setReject('Recipient domain is not configured for this inbox.');
		return;
	}

	await ensureSchema(env);

	const receivedAt = Date.now();
	const expiresAt = receivedAt + config.retentionHours * 60 * 60 * 1000;
	const rawSize = Number(message.rawSize) || 0;
	const envelopeSender = normalizeAddress(message.from) || String(message.from || '');
	const token = randomToken();

	// 大邮件不解析：免费套餐只有 10ms CPU，解析几 MB 的 MIME 会直接超限。
	// 但也不能让使用者以为"没收到"，所以留一条占位记录。
	if (rawSize > LIMITS.maxRawBytes) {
		await insertMessage(env, {
			token,
			address,
			sender: envelopeSender,
			senderName: '',
			subject: readHeaderSubject(message),
			code: '',
			text: '',
			html: '',
			hasHtml: false,
			imageCount: 0,
			rawSize,
			status: 'too_large',
			receivedAt,
			expiresAt,
		});
		return;
	}

	let parsed;
	try {
		const raw = await new Response(message.raw).arrayBuffer();
		parsed = await PostalMime.parse(raw);
	} catch (error) {
		console.error('邮件解析失败', { address, rawSize, error: String(error) });
		throw error;
	}

	const { images, urlByCid } = pickInlineImages(parsed, token);

	const rawHtml = parsed.html ? sanitizeHtml(parsed.html) : '';
	const html = rawHtml ? rewriteCidImages(rawHtml, urlByCid) : '';
	const text = parsed.text ? String(parsed.text) : htmlToText(html);
	const subject = String(parsed.subject || '').slice(0, 500);
	const code = extractCode({ subject, text, html });

	let messageId;
	try {
		messageId = await insertMessage(env, {
			token,
			address,
			sender: normalizeAddress(parsed.from?.address) || envelopeSender,
			senderName: String(parsed.from?.name || '').slice(0, 200),
			subject,
			code,
			text: text.slice(0, 200000),
			html: html.slice(0, 400000),
			hasHtml: Boolean(html),
			imageCount: images.length,
			rawSize,
			status: 'ok',
			receivedAt,
			expiresAt,
		});
	} catch (error) {
		console.error('邮件入库失败', { address, rawSize, error: String(error) });
		throw error;
	}

	try {
		await insertImages(env, messageId, images);
	} catch (error) {
		// 正文已入库，图片失败不算整封失败：把图片数改回真实值，避免谎报有图。
		console.error('内嵌图片保存失败', { address, messageId, error: String(error) });
		await env.db.prepare('UPDATE messages SET image_count = 0 WHERE id = ?').bind(messageId).run();
	}
}
