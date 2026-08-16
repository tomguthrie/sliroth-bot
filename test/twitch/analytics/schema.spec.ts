import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import migrationSql from '../../../src/db/twitch-analytics/migrations/20260815112814_damp_praxagora/migration.sql';

const migrations = [
  {
    name: '20260815112814_damp_praxagora',
    queries: migrationSql
      .split('--> statement-breakpoint')
      .map((query) => query.trim())
      .filter((query) => query.length > 0),
  },
];

beforeAll(async () => {
  await applyD1Migrations(env.TWITCH_ANALYTICS_DB, migrations);
});

describe('Twitch analytics D1 schema', () => {
  it('creates raw event, sample, and derived analytics tables', async () => {
    const result = await env.TWITCH_ANALYTICS_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const tables = result.results.map(({ name }) => name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'activity_events',
        'analytics_capabilities',
        'analytics_channels',
        'audience_samples',
        'chat_messages',
        'stream_category_rollups',
        'stream_metadata_changes',
        'stream_minute_rollups',
        'stream_segments',
        'stream_summaries',
        'streams',
      ]),
    );
  });

  it('retains channel IDs in shared D1 analytics rows', async () => {
    const columns = await env.TWITCH_ANALYTICS_DB.prepare(
      "PRAGMA table_info('audience_samples')",
    ).all<{ name: string }>();

    expect(columns.results.map(({ name }) => name)).toContain('channel_id');
  });

  it('rejects invalid audience samples at the database boundary', async () => {
    const now = Date.now();
    await env.TWITCH_ANALYTICS_DB.prepare(
      `INSERT INTO analytics_channels
       (channel_id, login, display_name, tracking_started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind('1234', 'sliroth', 'Sliroth', now, now, now)
      .run();

    await expect(
      env.TWITCH_ANALYTICS_DB.prepare(
        `INSERT INTO audience_samples
         (channel_id, sampled_at, viewer_count, source)
         VALUES (?, ?, ?, ?)`,
      )
        .bind('1234', now, -1, 'alarm')
        .run(),
    ).rejects.toThrow();
  });
});
