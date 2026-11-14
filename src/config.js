// 运行时配置与硬限制。改动这里要同步改 README 的说明。
export const LIMITS = Object.freeze({
	// 免费套餐每次请求只有 10ms CPU，解析大邮件会直接 EXCEEDED_CPU。
	// 超过这个大小的邮件不解析，只记录一条占位记录，让使用者知道"信到了但没存"。
	maxRawBytes: 1024 * 1024,
	maxImages: 8,
	maxImageBytes: 256 * 1024,
	pageSizeDefault: 20,
	pageSizeMax: 50,
});

// 网页等待节奏。服务端只对外声明，真正的轮询由网页执行。
export const WAIT = Object.freeze({
	intervalMs: 5000,
	maxMs: 180000,
});

function clampInt(value, fallback, min, max) {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export function readConfig(env) {
	const domains = String(env.MAIL_DOMAIN || '')
		.split(',')
		.map((item) => item.trim().toLowerCase().replace(/^@+/, ''))
		.filter(Boolean);

	return {
		domains,
		domain: domains[0] || '',
		retentionHours: clampInt(env.RETENTION_HOURS, 24, 1, 168),
		accessKey: String(env.ACCESS_KEY || '').trim(),
	};
}

export function normalizeAddress(value) {
	const address = String(value || '').trim().toLowerCase();
	if (!address || address.length > 320) return '';
	const at = address.lastIndexOf('@');
	if (at < 1 || at === address.length - 1) return '';
	if (address.includes(' ') || address.includes(',')) return '';
	return address;
}

export function isLocalAddress(address, config) {
	const at = address.lastIndexOf('@');
	if (at < 1) return false;
	return config.domains.includes(address.slice(at + 1));
}

// 本地部分是否合法：只允许常见字符，避免拿地址做探测。
export function isPlausibleLocalPart(prefix) {
	return /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/i.test(prefix);
}
