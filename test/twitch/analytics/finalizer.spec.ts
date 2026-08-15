import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import migrationSql from '../../../src/db/twitch-analytics/migrations/20260815112814_damp_praxagora/migration.sql';
import { TwitchAnalyticsFinalizer } from '../../../src/twitch/analytics/finalizer';

const CHANNEL_ID = '123456789012345678';
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
  const now = Date.now();
  await env.TWITCH_ANALYTICS_DB.prepare(
    `INSERT INTO analytics_channels
     (channel_id, login, display_name, tracking_started_at, created_at, updated_at)
     VALUES (?, 'sliroth', 'Sliroth', ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET updated_at = excluded.updated_at`,
  )
    .bind(CHANNEL_ID, now, now, now)
    .run();
});

describe('Twitch analytics finalizer', () => {
  it('materializes viewer, category, audience, chat, and activity statistics', async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const startedAt = new Date('2026-08-15T12:00:00.000Z');
    const endedAt = new Date('2026-08-15T12:03:00.000Z');
    await env.TWITCH_ANALYTICS_DB.batch([
      env.TWITCH_ANALYTICS_DB.prepare(
        `INSERT INTO streams
         (stream_id, channel_id, started_at, started_recorded_at, ended_at,
          ended_recorded_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'finalizing')`,
      ).bind(
        streamId,
        CHANNEL_ID,
        startedAt.getTime(),
        startedAt.getTime(),
        endedAt.getTime(),
        endedAt.getTime(),
      ),
      metadata(
        streamId,
        'metadata-1',
        startedAt,
        'First title',
        'game-1',
        'First game',
      ),
      metadata(
        streamId,
        'metadata-2',
        new Date('2026-08-15T12:01:30.000Z'),
        'Second title',
        'game-2',
        'Second game',
      ),
      audience(streamId, startedAt, 2, 100, 3),
      audience(streamId, new Date('2026-08-15T12:01:00.000Z'), 4, 101, 4),
      audience(streamId, new Date('2026-08-15T12:02:00.000Z'), 3, 102, 4),
      env.TWITCH_ANALYTICS_DB.prepare(
        `INSERT INTO chat_messages
         (event_sub_message_id, twitch_message_id, channel_id, stream_id,
          sent_at, received_at, chatter_user_id, chatter_login, chatter_name,
          message_type)
         VALUES (?, ?, ?, ?, ?, ?, 'viewer-1', 'viewer', 'Viewer', 'text')`,
      ).bind(
        `event-${crypto.randomUUID()}`,
        `message-${crypto.randomUUID()}`,
        CHANNEL_ID,
        streamId,
        startedAt.getTime() + 70_000,
        startedAt.getTime() + 70_000,
      ),
      activity(streamId, 'cheer', startedAt.getTime() + 80_000, 200, null),
      activity(
        streamId,
        'channel_points_redemption',
        startedAt.getTime() + 140_000,
        1_000,
        null,
      ),
      activity(streamId, 'follow', startedAt.getTime() + 150_000, null, 1),
    ]);

    await expect(
      new TwitchAnalyticsFinalizer(env).finalize(streamId, endedAt),
    ).resolves.toBe(true);

    const summary = await env.TWITCH_ANALYTICS_DB.prepare(
      `SELECT duration_seconds, viewer_seconds, viewer_covered_seconds,
              peak_viewers, follower_count_first, follower_count_last,
              subscriber_count_first, subscriber_count_last, chat_messages,
              unique_chatters, bits, channel_points, follows, display_title,
              primary_category_name
       FROM stream_summaries WHERE stream_id = ?`,
    )
      .bind(streamId)
      .first();
    expect(summary).toEqual({
      duration_seconds: 180,
      viewer_seconds: 540,
      viewer_covered_seconds: 180,
      peak_viewers: 4,
      follower_count_first: 100,
      follower_count_last: 102,
      subscriber_count_first: 3,
      subscriber_count_last: 4,
      chat_messages: 1,
      unique_chatters: 1,
      bits: 200,
      channel_points: 1_000,
      follows: 1,
      display_title: 'Second title',
      primary_category_name: 'First game',
    });
    const categories = await env.TWITCH_ANALYTICS_DB.prepare(
      `SELECT category_name, duration_seconds FROM stream_category_rollups
       WHERE stream_id = ? ORDER BY category_name`,
    )
      .bind(streamId)
      .all();
    expect(categories.results).toEqual([
      { category_name: 'First game', duration_seconds: 90 },
      { category_name: 'Second game', duration_seconds: 90 },
    ]);
  });
});

function metadata(
  streamId: string,
  changeId: string,
  occurredAt: Date,
  title: string,
  categoryId: string,
  categoryName: string,
) {
  return env.TWITCH_ANALYTICS_DB.prepare(
    `INSERT INTO stream_metadata_changes
     (change_id, channel_id, stream_id, occurred_at, recorded_at, title,
      category_id, category_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `${changeId}-${crypto.randomUUID()}`,
    CHANNEL_ID,
    streamId,
    occurredAt.getTime(),
    occurredAt.getTime(),
    title,
    categoryId,
    categoryName,
  );
}

function audience(
  streamId: string,
  sampledAt: Date,
  viewers: number,
  followers: number,
  subscribers: number,
) {
  return env.TWITCH_ANALYTICS_DB.prepare(
    `INSERT INTO audience_samples
     (channel_id, stream_id, sampled_at, viewer_count, follower_count,
      subscriber_count, source)
     VALUES (?, ?, ?, ?, ?, ?, 'alarm')`,
  ).bind(
    CHANNEL_ID,
    streamId,
    sampledAt.getTime(),
    viewers,
    followers,
    subscribers,
  );
}

function activity(
  streamId: string,
  kind: string,
  occurredAt: number,
  value: number | null,
  quantity: number | null,
) {
  return env.TWITCH_ANALYTICS_DB.prepare(
    `INSERT INTO activity_events
     (event_sub_message_id, channel_id, stream_id, kind, occurred_at,
      received_at, value, quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `activity-${crypto.randomUUID()}`,
    CHANNEL_ID,
    streamId,
    kind,
    occurredAt,
    occurredAt,
    value,
    quantity,
  );
}
