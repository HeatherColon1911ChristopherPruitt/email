// 验证码提取：纯规则，不调用任何模型。
//
// 选型理由：Workers AI 免费额度只有每天 1 万 Neurons，一次提取要几百毫秒到数秒，
// 额度用尽或模型抖动时还会静默返回空码；而验证邮件里的码几乎都出现在"验证码/验证码为/
// verification code"这类词附近。规则法零成本、零延迟、结果可解释，提不到码时按需求
// 明确返回空字符串，由调用方去查看原文，不假装"没收到邮件"。
//
// 已知边界：图片里的验证码、被拆成 "123 456" 的码、引用历史邮件里的旧码都可能取不到
// 或取错，需要人工看原文。
import { htmlToText } from './html.js';

const STRONG_KEYWORDS = [
	'验证码',
	'校验码',
	'确认码',
	'动态码',
	'动态密码',
	'安全码',
	'激活码',
	'登录码',
	'临时密码',
	'認証コード',
	'確認コード',
	'認証番号',
	'verification code',
	'confirmation code',
	'security code',
	'one-time password',
	'one-time code',
	'one time password',
	'one time code',
	'login code',
	'sign-in code',
	'sign in code',
	'access code',
	'passcode',
	'otp',
];

const WEAK_KEYWORDS = ['验证', '校验', 'code', 'pin', 'コード', 'verify', 'código'];

// 前后都不能是地址、路径或单词的一部分，避免从邮箱地址或链接里抠数字。
// 句末的句号和连字符不算边界（"482913." 很常见），URL 靠前面的 "/" 挡掉。
const CANDIDATE_RE = /(?<![A-Za-z0-9@/])([A-Za-z0-9]{4,8})(?![A-Za-z0-9@/])/g;

const DISCOUNT_RE = /优惠码|折扣|促销|代金券|兑换码|promo|coupon|discount|voucher/i;

const MIN_SCORE = 38;
const MAX_HITS = 240;

function normalizeText(value) {
	return String(value || '')
		.normalize('NFKC')
		.replace(/\u00a0/g, ' ');
}

function classify(value) {
	const digits = (value.match(/\d/g) || []).length;
	const letters = value.length - digits;
	if (digits === 0) return null;
	if (digits === 6 && letters === 0) return 'digits6';
	if (digits >= 4 && digits <= 5 && letters === 0) return 'digits45';
	if (digits === 4 && letters > 0) return 'mixedShort';
	if (digits >= 1 && letters >= 1) return 'mixed';
	return null;
}

function scoreOne({ value, gap, inSubject, strength, kind, context }) {
	let score = strength - Math.min(28, Math.floor(Math.max(0, gap) / 6));
	if (inSubject) score += 25;

	if (kind === 'digits6') score += 15;
	else if (kind === 'digits45') score += 8;
	else if (kind === 'mixed') score += 12;
	else if (kind === 'mixedShort') score += 2;

	if (/^(19|20)\d{2}$/.test(value)) score -= 80;
	if (DISCOUNT_RE.test(context)) score -= 40;

	return score;
}

function collect(hits, { text, inSubject, strength, from, to, after }) {
	if (to <= from) return;

	const window = text.slice(from, to);
	const context = text.slice(Math.max(0, from - 60), Math.min(text.length, to + 60));
	CANDIDATE_RE.lastIndex = 0;

	let match;
	while ((match = CANDIDATE_RE.exec(window)) !== null && hits.length < MAX_HITS) {
		const value = match[1];
		const kind = classify(value);
		if (!kind) continue;

		// after=true：窗口在关键词之后，gap 是从关键词末尾到候选词的距离。
		const gap = after ? match.index : window.length - (match.index + value.length);
		hits.push({ value, score: scoreOne({ value, gap, inSubject, strength, kind, context }), inSubject });
	}
}

function scanKeyword(hits, { haystack, lower, keyword, inSubject, strength }) {
	let index = lower.indexOf(keyword);
	let guard = 0;

	while (index !== -1 && guard < 40 && hits.length < MAX_HITS) {
		guard += 1;
		const end = index + keyword.length;

		// 关键词之后 90 个字符是黄金区域："验证码：834621，5 分钟内有效"。
		collect(hits, {
			text: haystack,
			inSubject,
			strength,
			from: end,
			to: Math.min(haystack.length, end + 90),
			after: true,
		});

		// 少量邮件写成 "834621 is your verification code"。
		collect(hits, {
			text: haystack,
			inSubject,
			strength: strength - 12,
			from: Math.max(0, index - 40),
			to: index,
			after: false,
		});

		index = lower.indexOf(keyword, end);
	}
}

export function extractCode({ subject = '', text = '', html = '' } = {}) {
	const cleanSubject = normalizeText(subject).slice(0, 300);
	const body = normalizeText(text || htmlToText(html)).slice(0, 20000);
	const hits = [];

	for (const [haystack, inSubject] of [
		[cleanSubject, true],
		[body, false],
	]) {
		if (!haystack) continue;
		const lower = haystack.toLowerCase();

		for (const keyword of STRONG_KEYWORDS) {
			scanKeyword(hits, { haystack, lower, keyword, inSubject, strength: 60 });
		}
		for (const keyword of WEAK_KEYWORDS) {
			scanKeyword(hits, { haystack, lower, keyword, inSubject, strength: 34 });
		}
	}

	// 有些站点整封邮件的主题就是验证码本身。
	const subjectOnly = cleanSubject.trim();
	if (/^[A-Za-z0-9]{4,8}$/.test(subjectOnly) && classify(subjectOnly)) {
		hits.push({ value: subjectOnly, score: 95, inSubject: true });
	}

	if (!hits.length) return '';

	hits.sort((a, b) => b.score - a.score || Number(b.inSubject) - Number(a.inSubject));

	const best = hits[0];
	return best.score >= MIN_SCORE ? best.value : '';
}
