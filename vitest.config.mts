import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          DISCORD_BOT_TOKEN: 'test-discord-bot-token',
          DISCORD_PUBLIC_KEY:
            'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
          PUBLIC_BASE_URL: 'https://bot.example.com',
        },
      },
      wrangler: {
        configPath: './wrangler.jsonc',
      },
    }),
  ],
});
