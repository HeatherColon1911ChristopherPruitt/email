import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { extractCode } from '../src/extract.js';
import { htmlToText, rewriteCidImages, sanitizeHtml } from '../src/html.js';

const KEY = 'test-key-123';

const PNG_1PX =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function buildRaw({ subject, text, html, withImage = false }) {
	const head = [
		'From: "Acme 安全中心" <no-reply@acme.test>',
		'To: abc@example.com',
		`Subject: ${subject}`,
		'MIME-Version: 1.0',
	];

	const alt = ['--ALT', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text, ''];

	if (html) {
		alt.push('--ALT', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', html, '');
	}
	alt.push('--ALT--', '');

	if (!withImage) {
		return [
			...head,
			'Content-Type: multipart/alternative; boundary="ALT"',
			'',
			...alt,
		].join('\r\n');
	}

	return [
		...head,
		'Content-Type: multipart/related; boundary="REL"',
		'',
		'--REL',
		'Content-Type: multipart/alternative; boundary="ALT"',
		'',
		...alt,
		'--REL',
		'Content-Type: image/png; name="logo.png"',
		'Content-ID: <logo123>',
		'Content-Transfer-Encoding: base64',
		'Content-Disposition: inline; filename="logo.png"',
		'',
		PNG_1PX,
		'',
		'--REL--',
		'',
	].join('\r\n');
}

function makeMessage(raw, { to = 'abc@example.com', from = 'no-reply@acme.test', rawSize, headers } = {}) {
	const bytes = new TextEncoder().encode(raw);
	const message = {
		to,
		from,
		headers: headers || new Headers(),
		rawSize: rawSize ?? bytes.byteLength,
		raw: new Response(bytes).body,
		rejected: null,
		setReject(reason) {
			message.rejected = reason;
		},
	};
	return message;
}

function request(path, options = {}) {
	return worker.fetch(new Request('https://inbox.example.com' + path, options), env, {});
}

async function api(path, options = {}) {
	return request(path, {
		...options,
		headers: { authorization: `Bearer ${KEY}`, ...(options.headers || {}) },
	});
}

describe('收件与查询主流程', () => {
	beforeEach(async () => {
		await request('/api/status'); // 触发建表，隔离存储里每个测试都是空库
		await env.db.prepare('DELETE FROM images').run();
		await env.db.prepare('DELETE FROM messages').run();
	});

	it('收下一封带内嵌图片的验证邮件，能取码、看图、删除', async () => {
		const raw = buildRaw({
			subject: '你的登录验证码',
			text: '您的验证码是 834621，5 分钟内有效。',
			html: '<html><body><p>您的验证码是 <b>834621</b>，5 分钟内有效。</p><img src="cid:logo123"></body></html>',
			withImage: true,
		});

		await worker.email(makeMessage(raw), env, { waitUntil() {} });

		const listResponse = await api('/api/messages?address=abc@example.com');
		expect(listResponse.status).toBe(200);
		const list = await listResponse.json();

		expect(list.count).toBe(1);
		expect(list.messages[0].code).toBe('834621');
		expect(list.messages[0].images).toBe(1);
		expect(list.messages[0].from).toBe('no-reply@acme.test');
		expect(list.messages[0].status).toBe('ok');

		const id = list.messages[0].id;
		const detail = await (await api(`/api/messages/${id}`)).json();

		expect(detail.html).toContain('<b>834621</b>');
		expect(detail.html).not.toContain('cid:logo123');
		expect(detail.images).toHaveLength(1);
		expect(detail.images[0].url).toMatch(/^\/i\/[0-9a-f]{32}\/1$/);

		// 图片地址不需要密钥，但不能绕过邮件有效期
		const imageResponse = await request(detail.images[0].url);
		expect(imageResponse.status).toBe(200);
		expect(imageResponse.headers.get('content-type')).toBe('image/png');

		const removed = await (await api(`/api/messages/${id}`, { method: 'DELETE' })).json();
		expect(removed.deleted).toBe(true);

		expect((await api(`/api/messages/${id}`)).status).toBe(404);
		expect((await request(detail.images[0].url)).status).toBe(404);

		// 重复删除是安全的
		const again = await (await api(`/api/messages/${id}`, { method: 'DELETE' })).json();
		expect(again.deleted).toBe(false);
	});

	it('没有验证码的邮件也算收到，返回空码而不是隐藏邮件', async () => {
		const raw = buildRaw({
			subject: '欢迎加入 Acme',
			text: '感谢注册，请点击链接完成设置。',
			html: '<p>感谢注册</p>',
		});

		await worker.email(makeMessage(raw), env, { waitUntil() {} });

		const list = await (await api('/api/messages?address=abc@example.com')).json();
		expect(list.count).toBe(1);
		expect(list.messages[0].code).toBe('');
		expect(list.messages[0].hasHtml).toBe(true);
	});

	it('超过大小上限的邮件留占位记录，不谎报收到正文', async () => {
		const raw = buildRaw({ subject: '大邮件', text: 'x' });
		const headers = new Headers({ subject: '=?UTF-8?B?5aSn6YKu5Lu25qCH6aKY?=' }); // "大邮件标题"
		await worker.email(makeMessage(raw, { rawSize: 5 * 1024 * 1024, headers }), env, { waitUntil() {} });

		const list = await (await api('/api/messages?address=abc@example.com')).json();
		expect(list.count).toBe(1);
		expect(list.messages[0].status).toBe('too_large');
		expect(list.messages[0].code).toBe('');
		// 不解析正文，但主题仍要从邮件头解出来，方便判断这封信是谁发的
		expect(list.messages[0].subject).toBe('大邮件标题');
	});

	it('since 只返回本次起点之后的邮件', async () => {
		const first = buildRaw({ subject: '旧邮件', text: '验证码 111111' });
		await worker.email(makeMessage(first), env, { waitUntil() {} });

		const baseline = Date.now() + 5;
		await new Promise((resolve) => setTimeout(resolve, 12));

		const second = buildRaw({ subject: '新邮件', text: '验证码 222222' });
		await worker.email(makeMessage(second), env, { waitUntil() {} });

		const all = await (await api('/api/messages?address=abc@example.com')).json();
		expect(all.count).toBe(2);

		const scoped = await (await api(`/api/messages?address=abc@example.com&since=${baseline}`)).json();
		expect(scoped.count).toBe(1);
		expect(scoped.messages[0].code).toBe('222222');

		// 列表默认最新优先，所以取最后一封（最早那封）的编号做游标
		const oldestId = all.messages[all.messages.length - 1].id;
		const after = await (await api(`/api/messages?address=abc@example.com&after=${oldestId}`)).json();
		expect(after.count).toBe(1);
		expect(after.messages[0].code).toBe('222222');
	});

	it('过期邮件查不到，列表也不会出现', async () => {
		const raw = buildRaw({ subject: '验证码', text: '验证码 654321' });
		await worker.email(makeMessage(raw), env, { waitUntil() {} });

		await env.db.prepare('UPDATE messages SET expires_at = ?').bind(Date.now() - 1000).run();

		const list = await (await api('/api/messages?address=abc@example.com')).json();
		expect(list.count).toBe(0);

		const id = (await env.db.prepare('SELECT id FROM messages').first()).id;
		expect((await api(`/api/messages/${id}`)).status).toBe(404);
	});

	it('定时任务清理过期邮件，图片一起删掉', async () => {
		const raw = buildRaw({
			subject: '验证码',
			text: '验证码 432100',
			html: '<p>验证码 432100</p><img src="cid:logo123">',
			withImage: true,
		});
		await worker.email(makeMessage(raw), env, { waitUntil() {} });

		expect((await env.db.prepare('SELECT COUNT(*) AS n FROM images').first()).n).toBe(1);

		await env.db.prepare('UPDATE messages SET expires_at = ?').bind(Date.now() - 1000).run();
		await worker.scheduled({ cron: '7 * * * *' }, env, {});

		expect((await env.db.prepare('SELECT COUNT(*) AS n FROM messages').first()).n).toBe(0);
		expect((await env.db.prepare('SELECT COUNT(*) AS n FROM images').first()).n).toBe(0);
	});

	it('拒绝非本域名的收件人', async () => {
		const raw = buildRaw({ subject: '验证码', text: '验证码 123456' });
		const message = makeMessage(raw, { to: 'abc@other.test' });
		await worker.email(message, env);
		expect(message.rejected).toBeTruthy();
	});

	it('接口必须带正确密钥', async () => {
		expect((await request('/api/status')).status).toBe(401);
		expect((await request('/api/messages?address=abc@example.com')).status).toBe(401);

		const wrong = await request('/api/status', {
			headers: { authorization: 'Bearer nope' },
		});
		expect(wrong.status).toBe(401);

		const ok = await api('/api/status');
		expect(ok.status).toBe(200);
		const status = await ok.json();
		expect(status.domain).toBe('example.com');
		expect(status.retentionHours).toBe(24);
	});

	it('地址不合法时明确报错', async () => {
		expect((await api('/api/messages')).status).toBe(400);
		expect((await api('/api/messages?address=abc')).status).toBe(400);
		expect((await api('/api/messages?address=abc@other.test')).status).toBe(400);
	});
});

describe('HTML 处理', () => {
	it('清掉脚本、事件属性和 javascript: 链接', () => {
		const input =
			'<p onclick="steal()">hi</p><script>alert(1)</script><a href="javascript:alert(2)">x</a><iframe src="//evil"></iframe>';
		const output = sanitizeHtml(input);

		expect(output).not.toContain('<script');
		expect(output).not.toContain('onclick');
		expect(output).not.toContain('javascript:');
		expect(output).not.toContain('<iframe');
		expect(output).toContain('hi');
	});

	it('cid 图片带引号或不带引号都能改写', () => {
		const map = new Map([
			['logo1', '/i/abc/1'],
			['logo2', '/i/abc/2'],
		]);
		const output = rewriteCidImages('<img src="cid:logo1"><img src=cid:logo2>', map);

		expect(output).toContain('/i/abc/1');
		expect(output).toContain('/i/abc/2');
		expect(output).not.toContain('cid:');
	});

	it('转文本时解码实体并保留换行', () => {
		expect(htmlToText('<p>验证码&nbsp;123456</p><p>&amp; 5 分钟</p>')).toBe('验证码 123456\n& 5 分钟');
	});
});

describe('验证码提取', () => {
	const cases = [
		['中文冒号', { subject: '验证', text: '您的验证码是 834621，5 分钟内有效。' }, '834621'],
		['英文句式', { subject: 'Sign in', text: 'Your verification code is 482913. It expires in 10 minutes.' }, '482913'],
		['字母数字混合', { subject: '登录确认', text: 'Use code 7K2Q9M to sign in. Do not share it.' }, '7K2Q9M'],
		['主题即验证码', { subject: '738291', text: '' }, '738291'],
		['链接干扰', { subject: '确认邮箱', text: '点击 https://acme.test/verify?x=998877 完成验证。验证码：513204' }, '513204'],
		['无验证码', { subject: '新品上架', text: '本周新品 5 折，订单满 199 包邮。' }, ''],
		['年份不误判', { subject: '年度账单', text: '2026 年度报告已生成，订单号 20261115001。' }, ''],
	];

	for (const [name, input, expected] of cases) {
		it(name, () => {
			expect(extractCode(input)).toBe(expected);
		});
	}
});
