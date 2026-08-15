import { env } from 'cloudflare:workers';
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import migrationSql from '../../../src/db/twitch-analytics/migrations/20260815112814_damp_praxagora/migration.sql';
import {
  analyticsAuthorization,
  analyticsPendingFinalizers,
  analyticsRuntime,
} from '../../../src/db/twitch-subscription/schema';

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
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.TOKEN_STORE.put('twitch', 'app-access-token');
  const now = Date.now();
  await env.TWITCH_ANALYTICS_DB.prepare(
    `INSERT INTO analytics_channels
     (channel_id, login, display_name, tracking_started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET updated_at = excluded.updated_at`,
  )
    .bind(CHANNEL_ID, 'sliroth', 'Sliroth', now, now, now)
    .run();
});

describe('Twitch analytics capture', () => {
  it('ignores analytics events for every other broadcaster', async () => {
    const twitchMessageId = `message-${crypto.randomUUID()}`;
    const subscription = await createActiveSubscription(null);
    await subscription.processEventSubMessage({
      kind: 'twitch-eventsub',
      messageId: `chat-${crypto.randomUUID()}`,
      timestamp: '2026-08-15T12:00:00.000Z',
      message: {
        messageType: 'notification',
        eventType: 'channel.chat.message',
        subscription: {
          ...eventSubSubscription('channel.chat.message', '1'),
          broadcasterId: '999999999999999999',
        },
        event: {
          broadcasterId: '999999999999999999',
          chatterUserId: 'viewer-1',
          chatterUserLogin: 'viewer',
          chatterUserName: 'Viewer',
          messageId: twitchMessageId,
          messageType: 'text',
        },
      },
    });

    const stored = await env.TWITCH_ANALYTICS_DB.prepare(
      'SELECT twitch_message_id FROM chat_messages WHERE twitch_message_id = ?',
    )
      .bind(twitchMessageId)
      .first();
    expect(stored).toBeNull();
  });

  it('records metadata, chat activity, and channel point spending', async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const subscription = await createActiveSubscription(streamId);
    const timestamp = '2026-08-15T12:00:00.000Z';

    await subscription.processEventSubMessage({
      kind: 'twitch-eventsub',
      messageId: `metadata-${crypto.randomUUID()}`,
      timestamp,
      message: {
        messageType: 'notification',
        eventType: 'channel.update',
        subscription: eventSubSubscription('channel.update', '2'),
        event: {
          broadcasterId: CHANNEL_ID,
          broadcasterLogin: 'sliroth',
          broadcasterName: 'Sliroth',
          title: 'A new title',
          language: 'en',
          gameId: 'game-1',
          gameName: 'A Category',
          contentClassificationLabels: [],
        },
      },
    });
    await subscription.processEventSubMessage({
      kind: 'twitch-eventsub',
      messageId: `chat-${crypto.randomUUID()}`,
      timestamp,
      message: {
        messageType: 'notification',
        eventType: 'channel.chat.message',
        subscription: eventSubSubscription('channel.chat.message', '1'),
        event: {
          broadcasterId: CHANNEL_ID,
          chatterUserId: 'viewer-1',
          chatterUserLogin: 'viewer',
          chatterUserName: 'Viewer',
          messageId: `message-${crypto.randomUUID()}`,
          messageType: 'text',
        },
      },
    });
    await subscription.processEventSubMessage({
      kind: 'twitch-eventsub',
      messageId: `points-${crypto.randomUUID()}`,
      timestamp,
      message: {
        messageType: 'notification',
        eventType: 'channel.channel_points_custom_reward_redemption.add',
        subscription: eventSubSubscription(
          'channel.channel_points_custom_reward_redemption.add',
          '1',
        ),
        event: {
          redemptionId: `redemption-${crypto.randomUUID()}`,
          userId: 'viewer-1',
          userLogin: 'viewer',
          userName: 'Viewer',
          rewardId: 'reward-1',
          rewardTitle: 'Hydrate',
          cost: 1000,
          redeemedAt: timestamp,
        },
      },
    });

    const [metadata, chat, activity] = await Promise.all([
      env.TWITCH_ANALYTICS_DB.prepare(
        'SELECT title, category_name FROM stream_metadata_changes WHERE stream_id = ?',
      )
        .bind(streamId)
        .first<{ title: string; category_name: string }>(),
      env.TWITCH_ANALYTICS_DB.prepare(
        'SELECT chatter_user_id, message_type FROM chat_messages WHERE stream_id = ?',
      )
        .bind(streamId)
        .first<{ chatter_user_id: string; message_type: string }>(),
      env.TWITCH_ANALYTICS_DB.prepare(
        'SELECT kind, value, unit FROM activity_events WHERE stream_id = ?',
      )
        .bind(streamId)
        .first<{ kind: string; value: number; unit: string }>(),
    ]);

    expect(metadata).toEqual({
      title: 'A new title',
      category_name: 'A Category',
    });
    expect(chat).toEqual({
      chatter_user_id: 'viewer-1',
      message_type: 'text',
    });
    expect(activity).toEqual({
      kind: 'channel_points_redemption',
      value: 1000,
      unit: 'channel_points',
    });
  });

  it('uses an alarm to sample viewers, followers, and subscribers', async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const subscription = await createActiveSubscription(streamId);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname === '/oauth2/token') {
        return Promise.resolve(
          Response.json({
            access_token: 'app-access-token',
            expires_in: 3600,
            token_type: 'bearer',
          }),
        );
      }
      if (url.pathname === '/helix/streams') {
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: streamId,
                user_id: CHANNEL_ID,
                user_login: 'sliroth',
                user_name: 'Sliroth',
                game_id: 'game-1',
                game_name: 'A Category',
                title: 'Alarm test',
                viewer_count: 4,
                started_at: '2026-08-15T11:00:00Z',
                thumbnail_url: 'https://example.com/preview.jpg',
              },
            ],
          }),
        );
      }
      if (url.pathname === '/helix/channels/followers') {
        return Promise.resolve(Response.json({ data: [], total: 119 }));
      }
      if (url.pathname === '/helix/subscriptions') {
        return Promise.resolve(Response.json({ data: [], total: 1 }));
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    await runInDurableObject(subscription, (instance) => instance.alarm());
    const scheduledAlarm = await runInDurableObject(
      subscription,
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(scheduledAlarm).not.toBeNull();

    const sample = await env.TWITCH_ANALYTICS_DB.prepare(
      `SELECT viewer_count, follower_count, subscriber_count, source
       FROM audience_samples WHERE stream_id = ? ORDER BY sampled_at DESC LIMIT 1`,
    )
      .bind(streamId)
      .first<{
        viewer_count: number;
        follower_count: number;
        subscriber_count: number;
        source: string;
      }>();
    expect(sample).toEqual({
      viewer_count: 4,
      follower_count: 119,
      subscriber_count: 1,
      source: 'alarm',
    });
  });

  it('does not poll or schedule another alarm while offline', async () => {
    const subscription = await createActiveSubscription(null);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Offline analytics must not fetch'));

    await runInDurableObject(subscription, (instance) => instance.alarm());

    expect(fetchSpy).not.toHaveBeenCalled();
    const scheduledAlarm = await runInDurableObject(
      subscription,
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(scheduledAlarm).toBeNull();
  });

  it('finalizes a completed stream while offline without polling Twitch', async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const subscription = await createActiveSubscription(null);
    const startedAt = Date.now() - 3 * 60 * 1000;
    const endedAt = Date.now() - 60 * 1000;
    await env.TWITCH_ANALYTICS_DB.prepare(
      `INSERT INTO streams
       (stream_id, channel_id, started_at, started_recorded_at, ended_at,
        ended_recorded_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'finalizing')`,
    )
      .bind(streamId, CHANNEL_ID, startedAt, startedAt, endedAt, endedAt)
      .run();
    await runInDurableObject(subscription, async (_instance, state) => {
      const database = drizzle(state.storage);
      await database.insert(analyticsPendingFinalizers).values({
        streamId,
        finalizeAfter: new Date(0),
      });
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Finalization must not fetch Twitch'));

    await runInDurableObject(subscription, (instance) => instance.alarm());

    expect(fetchSpy).not.toHaveBeenCalled();
    const stored = await env.TWITCH_ANALYTICS_DB.prepare(
      'SELECT status, finalized_at FROM streams WHERE stream_id = ?',
    )
      .bind(streamId)
      .first<{ status: string; finalized_at: number | null }>();
    expect(stored?.status).toBe('finalized');
    expect(stored?.finalized_at).not.toBeNull();
    const pending = await runInDurableObject(
      subscription,
      async (_instance, state) => {
        const database = drizzle(state.storage);
        return database.select().from(analyticsPendingFinalizers);
      },
    );
    expect(pending).toEqual([]);
  });

  it('still ends a stream when its final audience sample fails', async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const subscription = await createActiveSubscription(streamId);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Twitch is temporarily unavailable'),
    );

    await subscription.processEventSubMessage({
      kind: 'twitch-eventsub',
      messageId: `offline-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      message: {
        messageType: 'notification',
        eventType: 'stream.offline',
        subscription: eventSubSubscription('stream.offline', '1'),
        event: {
          streamId,
          broadcasterId: CHANNEL_ID,
          broadcasterLogin: 'sliroth',
          broadcasterName: 'Sliroth',
        },
      },
    });

    const stream = await env.TWITCH_ANALYTICS_DB.prepare(
      'SELECT status, ended_at FROM streams WHERE stream_id = ?',
    )
      .bind(streamId)
      .first<{ status: string; ended_at: number | null }>();
    expect(stream?.status).toBe('finalizing');
    expect(stream?.ended_at).not.toBeNull();
    const scheduledAlarm = await runInDurableObject(
      subscription,
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(scheduledAlarm).not.toBeNull();
  });

  it('clears a persisted offline suspicion when the stream reappears', async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const subscription = await createActiveSubscription(streamId);
    let streamIsLive = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname !== '/helix/streams') {
        throw new Error(`Unexpected request: ${url.toString()}`);
      }
      return Promise.resolve(
        Response.json({
          data: streamIsLive ? [twitchStream(streamId)] : [],
        }),
      );
    });

    await makeViewerSampleDue(subscription);
    await runInDurableObject(subscription, (instance) => instance.alarm());
    const suspected = await readAnalyticsRuntime(subscription);
    expect(suspected.activeStreamId).toBe(streamId);
    expect(suspected.offlineSuspectedAt).not.toBeNull();
    expect(suspected.consecutiveStreamMisses).toBe(1);

    streamIsLive = true;
    await makeViewerSampleDue(subscription);
    await runInDurableObject(subscription, (instance) => instance.alarm());
    const recovered = await readAnalyticsRuntime(subscription);
    expect(recovered.activeStreamId).toBe(streamId);
    expect(recovered.offlineSuspectedAt).toBeNull();
    expect(recovered.consecutiveStreamMisses).toBe(0);
  });

  it('ends a stream after three persisted live-check misses', async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const subscription = await createActiveSubscription(streamId);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname !== '/helix/streams') {
        throw new Error(`Unexpected request: ${url.toString()}`);
      }
      return Promise.resolve(Response.json({ data: [] }));
    });

    let suspectedAt: Date | null = null;
    for (let misses = 1; misses <= 3; misses += 1) {
      await makeViewerSampleDue(subscription);
      await runInDurableObject(subscription, (instance) => instance.alarm());
      const runtime = await readAnalyticsRuntime(subscription);
      if (misses === 1) suspectedAt = runtime.offlineSuspectedAt;
      if (misses < 3) {
        expect(runtime.activeStreamId).toBe(streamId);
        expect(runtime.offlineSuspectedAt).toEqual(suspectedAt);
        expect(runtime.consecutiveStreamMisses).toBe(misses);
      } else {
        expect(runtime.activeStreamId).toBeNull();
        expect(runtime.offlineSuspectedAt).toBeNull();
        expect(runtime.consecutiveStreamMisses).toBe(0);
      }
    }

    expect(suspectedAt).not.toBeNull();
    const stream = await env.TWITCH_ANALYTICS_DB.prepare(
      'SELECT status, ended_at FROM streams WHERE stream_id = ?',
    )
      .bind(streamId)
      .first<{ status: string; ended_at: number }>();
    expect(stream).toEqual({
      status: 'finalizing',
      ended_at: suspectedAt?.getTime(),
    });
    const scheduledAlarm = await runInDurableObject(
      subscription,
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(scheduledAlarm).not.toBeNull();
  });
});

type TwitchSubscriptionStub = Awaited<
  ReturnType<typeof createActiveSubscription>
>;

async function makeViewerSampleDue(
  subscription: TwitchSubscriptionStub,
): Promise<void> {
  await runInDurableObject(subscription, async (_instance, state) => {
    const database = drizzle(state.storage);
    await database.update(analyticsRuntime).set({
      nextViewerSampleAt: new Date(0),
      nextAudienceSampleAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });
}

function readAnalyticsRuntime(subscription: TwitchSubscriptionStub) {
  return runInDurableObject(subscription, async (_instance, state) => {
    const database = drizzle(state.storage);
    const [runtime] = await database.select().from(analyticsRuntime).limit(1);
    if (runtime === undefined) throw new Error('Analytics runtime not found');
    return runtime;
  });
}

async function createActiveSubscription(activeStreamId: string | null) {
  const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(crypto.randomUUID());
  const now = new Date();
  await runInDurableObject(subscription, async (_instance, state) => {
    const database = drizzle(state.storage);
    await database.insert(analyticsAuthorization).values({
      singleton: 1,
      accessToken: 'user-access-token',
      refreshToken: 'user-refresh-token',
      scopesJson: '[]',
      authorizedAt: now,
      validatedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    await database.insert(analyticsRuntime).values({
      singleton: 1,
      status: 'active',
      enabledAt: now,
      activeStreamId,
      nextViewerSampleAt: now,
      nextAudienceSampleAt: now,
      nextTokenValidationAt: new Date(now.getTime() + 60 * 60 * 1000),
      nextEventSubAuditAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
  });
  if (activeStreamId !== null) {
    const timestamp = Date.now();
    await env.TWITCH_ANALYTICS_DB.prepare(
      `INSERT INTO streams
       (stream_id, channel_id, started_at, started_recorded_at, status)
       VALUES (?, ?, ?, ?, 'live')`,
    )
      .bind(activeStreamId, CHANNEL_ID, timestamp, timestamp)
      .run();
  }
  return subscription;
}

function eventSubSubscription(type: string, version: string) {
  return {
    id: `subscription-${crypto.randomUUID()}`,
    type,
    version,
    broadcasterId: CHANNEL_ID,
  };
}

function twitchStream(streamId: string) {
  return {
    id: streamId,
    user_id: CHANNEL_ID,
    user_login: 'sliroth',
    user_name: 'Sliroth',
    game_id: 'game-1',
    game_name: 'A Category',
    title: 'Fallback test',
    viewer_count: 4,
    started_at: '2026-08-15T11:00:00Z',
    thumbnail_url: 'https://example.com/preview.jpg',
  };
}
