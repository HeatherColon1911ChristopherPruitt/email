import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.toml' },
			miniflare: {
				bindings: {
					ACCESS_KEY: 'test-key-123',
					MAIL_DOMAIN: 'example.com',
					RETENTION_HOURS: '24',
				},
			},
		}),
	],
});
