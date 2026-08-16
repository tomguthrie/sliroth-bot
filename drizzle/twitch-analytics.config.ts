import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/twitch-analytics/schema.ts',
  out: './src/db/twitch-analytics/migrations',
});
