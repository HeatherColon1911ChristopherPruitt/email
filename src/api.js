// HTTP 接口。四个核心职责：状态、列表、详情、删除；图片单独一个读取地址。
import { LIMITS, WAIT, isLocalAddress, normalizeAddress, readConfig } from './config.js';
import {
	cleanupExpired,
	deleteMessage,
	getImageByToken,
	getMessage,
	listImageMeta,
	listMessages,
} from './db.js';

const CORS_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, DELETE, OPTIONS',
	'access-control-allow-headers': 'Authorization, X-Access-Key, Content-Type',
	'access-control-max-age': '86400',
};

export function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...CORS_HEADERS,
		},
	});
}

export function fail(code, message, status = 400) {
	return json({ error: { code, message } }, status);
}

function sameSecret(a, b) {
	const left = new TextEncoder().encode(String(a));
	const right = new TextEncoder().encode(String(b));
	let diff = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i += 1) {
		diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return diff === 0;
}

function readKey(request) {
	const header = request.headers.get('authorization') || '';
	if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
	return (request.headers.get('x-access-key') || '').trim();
}

function parsePositiveInt(value) {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function toMessageSummary(row) {
	return {
		id: row.id,
		address: row.address,
		from: row.sender,
		fromName: row.sender_name,
		subject: row.subject,
		code: row.code,
		receivedAt: row.received_at,
		expiresAt: row.expires_at,
		hasHtml: Boolean(row.has_html),
		images: row.image_count,
		status: row.status,
	};
}

export async function handleApi(request, env, url) {
	const config = readConfig(env);

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	if (!config.accessKey) {
		return fail('not_configured', '服务未设置访问密钥，部署者需要在 Cloudflare 配置 ACCESS_KEY。', 503);
	}

	if (!config.domains.length) {
		return fail('not_configured', '服务未设置邮箱域名，部署者需要在 wrangler.toml 配置 MAIL_DOMAIN。', 503);
	}

	if (!sameSecret(readKey(request), config.accessKey)) {
		return fail('unauthorized', '访问密钥不正确。', 401);
	}

	const segments = url.pathname.split('/').filter(Boolean);

	// /api/status
	if (url.pathname === '/api/status' && request.method === 'GET') {
		return json({
			ok: true,
			domain: config.domain,
			domains: config.domains,
			serverTime: Date.now(),
			retentionHours: config.retentionHours,
			limits: {
				maxRawBytes: LIMITS.maxRawBytes,
				maxImages: LIMITS.maxImages,
				maxImageBytes: LIMITS.maxImageBytes,
				pageSizeMax: LIMITS.pageSizeMax,
				pageSizeDefault: LIMITS.pageSizeDefault,
			},
			wait: WAIT,
		});
	}

	// /api/messages
	if (url.pathname === '/api/messages' && request.method === 'GET') {
		const rawAddress = url.searchParams.get('address') || '';
		const address = normalizeAddress(rawAddress);

		if (!address) {
			return fail('invalid_address', '必须提供完整邮件地址，例如 abc@example.com。');
		}
		if (!isLocalAddress(address, config)) {
			return fail('invalid_address', `地址必须属于本服务的邮箱域名：${config.domains.join(', ')}。`);
		}

		const limitParam = parsePositiveInt(url.searchParams.get('limit'));
		const limit = Math.min(LIMITS.pageSizeMax, limitParam || LIMITS.pageSizeDefault);

		const rows = await listMessages(env, {
			address,
			now: Date.now(),
			since: parsePositiveInt(url.searchParams.get('since')) || 0,
			after: parsePositiveInt(url.searchParams.get('after')) || 0,
			before: parsePositiveInt(url.searchParams.get('before')) || 0,
			limit,
			from: (url.searchParams.get('from') || '').slice(0, 40),
			subject: (url.searchParams.get('subject') || '').slice(0, 40),
		});

		const messages = rows.map(toMessageSummary);
		const cursor = messages.length ? Math.max(...messages.map((item) => item.id)) : null;

		return json({
			address,
			count: messages.length,
			cursor,
			messages,
			serverTime: Date.now(),
		});
	}

	// /api/messages/{id}
	if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'messages') {
		const id = parsePositiveInt(segments[2]);
		if (!id) return fail('bad_request', '邮件编号必须是正整数。');

		if (request.method === 'GET') {
			const row = await getMessage(env, id, Date.now());
			if (!row) return fail('not_found', '邮件不存在，或已删除、已过期。', 404);

			const images = await listImageMeta(env, id);

			return json({
				...toMessageSummary(row),
				text: row.text_body,
				html: row.html_body,
				rawSize: row.raw_size,
				images: images.map((image) => ({
					seq: image.seq,
					contentType: image.content_type,
					size: image.byte_size,
					url: `/i/${row.token}/${image.seq}`,
				})),
			});
		}

		if (request.method === 'DELETE') {
			const deleted = await deleteMessage(env, id);
			return json({ id, deleted });
		}

		return fail('bad_request', '不支持的请求方法。', 405);
	}

	// /api/cleanup：手动触发一次过期清理，方便验收和排查，不对外宣传。
	if (url.pathname === '/api/cleanup' && request.method === 'POST') {
		const removed = await cleanupExpired(env, Date.now());
		return json({ removed });
	}

	return fail('not_found', '没有这个接口。', 404);
}

// 图片地址用随机 token 作为能力凭据：浏览器加载 <img> 无法附带请求头，
// 而邮件被删除或过期后 join 查不到记录，地址立即失效。
export async function handleImage(env, token, seq) {
	if (!/^[0-9a-f]{32}$/i.test(token)) return new Response('Not Found', { status: 404 });

	const row = await getImageByToken(env, token, Number.parseInt(seq, 10) || 0, Date.now());
	if (!row) return new Response('Not Found', { status: 404 });

	let body = row.body;
	if (!(body instanceof ArrayBuffer)) {
		body = new Uint8Array(Array.isArray(body) ? body : []).buffer;
	}

	return new Response(body, {
		headers: {
			'content-type': row.content_type || 'application/octet-stream',
			'content-disposition': 'inline',
			'cache-control': 'private, max-age=600',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
		},
	});
}
