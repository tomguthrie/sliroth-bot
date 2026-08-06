import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const testBindings = {
  DISCORD_BOT_TOKEN: 'test-discord-bot-token',
  DISCORD_CHANNEL_ID: '123456789012345678',
  DISCORD_YT_ROLE_ID: '234567890123456789',
  PUBLIC_BASE_URL: 'https://bot.example.com',
  YOUTUBE_CHANNEL_ID: 'UC_TEST_CHANNEL_ID',
  YOUTUBE_CALLBACK_TOKEN: 'test-youtube-callback-token',
  YOUTUBE_WEBSUB_SECRET: 'test-youtube-websub-secret',
};

// Wrangler validates required secrets before Miniflare applies its overrides.
Object.assign(process.env, testBindings);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
      miniflare: {
        bindings: testBindings,
      },
    }),
  ],
});
