import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          DISCORD_BOT_TOKEN: 'test-discord-bot-token',
          PUBLIC_BASE_URL: 'https://bot.example.com',
        },
      },
      wrangler: {
        configPath: './wrangler.jsonc',
      },
    }),
  ],
});
