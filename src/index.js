import { handleApi, handleImage } from './api.js';
import { cleanupExpired, ensureSchema } from './db.js';
import { handleIncoming } from './inbound.js';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		try {
			if (url.pathname.startsWith('/api/')) {
				await ensureSchema(env);
				return await handleApi(request, env, url);
			}

			if (url.pathname.startsWith('/i/')) {
				await ensureSchema(env);
				const [, , token, seq] = url.pathname.split('/');
				return await handleImage(env, token || '', seq || '0');
			}
		} catch (error) {
			console.error('请求处理失败', { path: url.pathname, error: String(error) });
			return new Response(
				JSON.stringify({ error: { code: 'server_error', message: '服务内部错误，请稍后重试。' } }),
				{ status: 500, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
			);
		}

		if (!env.ASSETS) {
			return new Response('Not Found', { status: 404 });
		}
		return env.ASSETS.fetch(request);
	},

	async email(message, env) {
		await handleIncoming(message, env);
	},

	async scheduled(controller, env) {
		try {
			await ensureSchema(env);
			const removed = await cleanupExpired(env, Date.now());
			console.log('过期清理完成', { cron: controller.cron, removed });
		} catch (error) {
			console.error('过期清理失败', { cron: controller.cron, error: String(error) });
		}
	},
};
