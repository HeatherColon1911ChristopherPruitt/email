// 邮件 HTML 的轻量处理。真正隔离不可信内容的是网页里的 sandbox iframe，
// 这里的清理只是第二道防线，不声称能替代浏览器沙箱。

const BLOCKED_TAGS = ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'];

const ENTITIES = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ensp: ' ',
	emsp: ' ',
	thinsp: ' ',
	zwnj: '',
	zwj: '',
	shy: '',
	hellip: '…',
	mdash: '—',
	ndash: '–',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	middot: '·',
	bull: '•',
	copy: '©',
	reg: '®',
	trade: '™',
	euro: '€',
	pound: '£',
	yen: '¥',
};

export function decodeEntities(input) {
	return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
		if (body[0] === '#') {
			const isHex = body[1] === 'x' || body[1] === 'X';
			const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
			try {
				return String.fromCodePoint(code);
			} catch {
				return match;
			}
		}
		const key = body.toLowerCase();
		return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : match;
	});
}

// 把 HTML 变成用于提码和纯文本展示的文本。
export function htmlToText(html) {
	if (!html) return '';

	let output = String(html)
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

	output = output
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|blockquote)>/gi, '\n')
		.replace(/<li\b[^>]*>/gi, '\n· ')
		.replace(/<[^>]+>/g, ' ');

	output = decodeEntities(output)
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t\u00a0]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n');

	return output.trim();
}

// 去掉脚本、内嵌框架、事件属性和 javascript: 链接。
export function sanitizeHtml(html) {
	if (!html) return '';

	let output = String(html).replace(/<!--[\s\S]*?-->/g, '');

	for (const tag of BLOCKED_TAGS) {
		output = output
			.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
			.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
	}

	// 只在标签内部清属性，避免误伤正文文字。
	output = output.replace(/<[a-zA-Z][^>]*>/g, (tag) =>
		tag
			.replace(/\s+on[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, '')
			.replace(/\s+(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, ''),
	);

	return output;
}

// 把 cid: 内嵌图片换成站内地址，其余 src 原样保留（外链图片由收件人浏览器自行加载）。
// 引号包裹和未加引号的写法都要处理，邮件客户端生成的 HTML 两种都常见。
export function rewriteCidImages(html, urlByCid) {
	if (!html || urlByCid.size === 0) return html;

	return String(html)
		.replace(
			/(<img\b[^>]*?\bsrc\s*=\s*)(["'])cid:([^"']+)\2/gi,
			(match, prefix, quote, rawCid) => {
				const url = lookupCid(urlByCid, rawCid);
				return url ? `${prefix}${quote}${url}${quote}` : match;
			},
		)
		.replace(/(<img\b[^>]*?\bsrc\s*=\s*)cid:([^\s"'>]+)/gi, (match, prefix, rawCid) => {
			const url = lookupCid(urlByCid, rawCid);
			return url ? `${prefix}${url}` : match;
		});
}

function lookupCid(urlByCid, rawCid) {
	const cid = decodeCid(rawCid);
	return urlByCid.get(cid) || urlByCid.get(cid.toLowerCase());
}

function decodeCid(rawCid) {
	let cid = String(rawCid).trim().replace(/^<|>$/g, '');
	try {
		cid = decodeURIComponent(cid);
	} catch {
		// 百分号编码不合法时按原样比较
	}
	return cid;
}
