import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('YouTubeSubscription', () => {
  it('initializes Drizzle migrations before handling events', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    const migrationTables = await runInDurableObject(
      subscription,
      (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            '__drizzle_migrations',
          )
          .toArray(),
    );

    expect(migrationTables).toEqual([{ name: '__drizzle_migrations' }]);
  });
});
