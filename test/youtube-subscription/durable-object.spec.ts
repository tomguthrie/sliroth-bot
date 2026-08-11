import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribers, videos } from '../../src/db/youtube-subscription/schema';
import { YouTubeChannelId } from '../../src/youtube/data';
import type { YouTubeSubscription } from '../../src/youtube-subscription/durable-object';

const GUILD_ID = '123456789012345678';
const OTHER_GUILD_ID = '234567890123456789';
const CHANNEL_ID = '345678901234567890';
const ROLE_ID = '456789012345678901' as const;

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(null, { status: 202 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('creates camelCase models backed by snake_case columns', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    const schema = await runInDurableObject(
      subscription,
      (_instance, state) => ({
        subscriberColumns: state.storage.sql
          .exec<{ name: string }>("PRAGMA table_info('subscribers')")
          .toArray()
          .map(({ name }) => name),
        videoColumns: state.storage.sql
          .exec<{ name: string }>("PRAGMA table_info('videos')")
          .toArray()
          .map(({ name }) => name),
        subscriberIndexes: state.storage.sql
          .exec<{ name: string }>("PRAGMA index_list('subscribers')")
          .toArray()
          .map(({ name }) => name),
      }),
    );

    expect(schema.subscriberColumns).toEqual([
      'channel_id',
      'guild_id',
      'message',
      'ping',
      'created_at',
      'updated_at',
    ]);
    expect(schema.videoColumns).toEqual(['id', 'title', 'published_at']);
    expect(schema.subscriberIndexes).toContain('subscribers_guild_id_idx');
  });

  it('stores videos with Date timestamps and unique IDs', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );
    const publishedAt = new Date('2026-08-07T12:34:56.789Z');

    await runInDurableObject(subscription, async (_instance, state) => {
      const database = drizzle(state.storage);
      const inserted = await database
        .insert(videos)
        .values({
          id: 'youtube-video-id',
          title: 'A YouTube video',
          publishedAt,
        })
        .returning();

      expect(inserted).toEqual([
        {
          id: 'youtube-video-id',
          title: 'A YouTube video',
          publishedAt,
        },
      ]);

      await expect(
        database.insert(videos).values({
          id: 'youtube-video-id',
          title: 'A duplicate',
          publishedAt,
        }),
      ).rejects.toThrow();
    });
  });

  it('stores subscriber defaults and refreshes updatedAt', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    await runInDurableObject(subscription, async (_instance, state) => {
      const database = drizzle(state.storage);
      const initialUpdatedAt = new Date('2020-01-01T00:00:00Z');
      const [inserted] = await database
        .insert(subscribers)
        .values({
          channelId: '123456789012345678',
          guildId: '234567890123456789',
          updatedAt: initialUpdatedAt,
        })
        .returning();

      expect(inserted).toMatchObject({
        channelId: '123456789012345678',
        guildId: '234567890123456789',
        message: null,
        ping: null,
        updatedAt: initialUpdatedAt,
      });
      expect(inserted?.createdAt).toBeInstanceOf(Date);

      await expect(
        database.insert(subscribers).values({
          channelId: '123456789012345678',
          guildId: '345678901234567890',
        }),
      ).rejects.toThrow();

      const [updated] = await database
        .update(subscribers)
        .set({ message: 'A custom message' })
        .where(eq(subscribers.channelId, '123456789012345678'))
        .returning();

      expect(updated?.message).toBe('A custom message');
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(
        initialUpdatedAt.getTime(),
      );
    });
  });

  it.each([null, 'everyone', 'here', '345678901234567890'])(
    'accepts the subscriber ping value %s',
    async (ping) => {
      const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
        crypto.randomUUID(),
      );

      await runInDurableObject(subscription, (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO subscribers (channel_id, guild_id, ping) VALUES (?, ?, ?)',
          crypto.randomUUID(),
          '234567890123456789',
          ping,
        );
      });
    },
  );

  it('adds a subscriber and creates both global lookup indexes', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);

    await expect(
      subscription.addSubscriber({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        channelTitle: 'YouTube channel',
        message: 'A custom message',
        ping: ROLE_ID,
      }),
    ).resolves.toBeUndefined();

    const subscriberRows = await readSubscribers(subscription);
    expect(subscriberRows).toEqual([
      expect.objectContaining({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        message: 'A custom message',
        ping: ROLE_ID,
      }),
    ]);
    await expect(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.getWithMetadata(
        createGuildYouTubeSubscriptionKey(
          GUILD_ID,
          CHANNEL_ID,
          youtubeChannelId,
        ),
      ),
    ).resolves.toMatchObject({
      value: '1',
      metadata: { title: 'YouTube channel' },
    });
    await expect(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.getWithMetadata(
        createChannelYouTubeSubscriptionKey(CHANNEL_ID, youtubeChannelId),
      ),
    ).resolves.toMatchObject({ value: '1', metadata: null });
  });

  it('upserts subscriber settings without changing its guild', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);

    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      channelTitle: 'Original title',
      message: 'A custom message',
      ping: 'everyone',
    });
    await subscription.addSubscriber({
      guildId: OTHER_GUILD_ID,
      channelId: CHANNEL_ID,
      channelTitle: 'Updated title',
    });

    expect(await readSubscribers(subscription)).toEqual([
      expect.objectContaining({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        message: null,
        ping: null,
      }),
    ]);
    await expect(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.getWithMetadata(
        createGuildYouTubeSubscriptionKey(
          GUILD_ID,
          CHANNEL_ID,
          youtubeChannelId,
        ),
      ),
    ).resolves.toMatchObject({
      value: '1',
      metadata: { title: 'Updated title' },
    });
    await expect(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.get(
        createGuildYouTubeSubscriptionKey(
          OTHER_GUILD_ID,
          CHANNEL_ID,
          youtubeChannelId,
        ),
      ),
    ).resolves.toBeNull();
    await expect(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.get(
        createChannelYouTubeSubscriptionKey(CHANNEL_ID, youtubeChannelId),
      ),
    ).resolves.toBe('1');
  });

  it('removes a subscriber and both global lookup indexes', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    const guildKey = createGuildYouTubeSubscriptionKey(
      GUILD_ID,
      CHANNEL_ID,
      youtubeChannelId,
    );
    const channelKey = createChannelYouTubeSubscriptionKey(
      CHANNEL_ID,
      youtubeChannelId,
    );

    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      channelTitle: 'YouTube channel',
    });
    await expect(
      subscription.removeSubscriber(CHANNEL_ID),
    ).resolves.toBeUndefined();

    await expect(readSubscribers(subscription)).resolves.toEqual([]);
    await expect(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.get(guildKey),
    ).resolves.toBeNull();
    await expect(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.get(channelKey),
    ).resolves.toBeNull();
    await expect(
      subscription.removeSubscriber(CHANNEL_ID),
    ).resolves.toBeUndefined();
  });

  it('validates subscriber registrations before changing storage', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      `youtube-${crypto.randomUUID()}`,
    );

    await expect(
      runInDurableObject(subscription, (instance: YouTubeSubscription) =>
        instance.addSubscriber({
          guildId: 'not-a-guild',
          channelId: CHANNEL_ID,
          channelTitle: 'YouTube channel',
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runInDurableObject(subscription, (instance: YouTubeSubscription) =>
        instance.addSubscriber({
          guildId: GUILD_ID,
          channelId: CHANNEL_ID,
          channelTitle: '   ',
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runInDurableObject(subscription, (instance: YouTubeSubscription) =>
        instance.addSubscriber({
          guildId: GUILD_ID,
          channelId: CHANNEL_ID,
          channelTitle: 'YouTube channel',
          message: '   ',
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runInDurableObject(subscription, (instance: YouTubeSubscription) =>
        instance.addSubscriber({
          guildId: GUILD_ID,
          channelId: CHANNEL_ID,
          channelTitle: 'YouTube channel',
          ping: 'not-a-role',
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runInDurableObject(subscription, (instance: YouTubeSubscription) =>
        instance.removeSubscriber('not-a-channel'),
      ),
    ).rejects.toThrow();
    await expect(readSubscribers(subscription)).resolves.toEqual([]);
  });

  it('records a new video and queues subscriber messages', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);

    await runInDurableObject(subscription, async (_instance, state) => {
      const database = drizzle(state.storage);
      await database.insert(subscribers).values([
        {
          channelId: '123456789012345678',
          guildId: '234567890123456789',
        },
        {
          channelId: '345678901234567890',
          guildId: '456789012345678901',
          message: 'A custom notification',
          ping: 'here',
        },
      ]);
    });

    await expect(
      subscription.recordVideo({
        videoId: 'dQw4w9WgXcQ',
        channelId: youtubeChannelId,
        title: 'A YouTube video',
        publishedAt: '2026-08-07T12:34:56.789Z',
      }),
    ).resolves.toBeUndefined();

    const storedVideos = await runInDurableObject(
      subscription,
      async (_instance, state) => drizzle(state.storage).select().from(videos),
    );
    expect(storedVideos).toEqual([
      {
        id: 'dQw4w9WgXcQ',
        title: 'A YouTube video',
        publishedAt: new Date('2026-08-07T12:34:56.789Z'),
      },
    ]);
  });

  it('records a video without calling Queue when there are no subscribers', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);

    await expect(
      subscription.recordVideo({
        videoId: 'zero-subscribers',
        channelId: youtubeChannelId,
        title: 'A YouTube video',
        publishedAt: '2026-08-07T12:34:56.789Z',
      }),
    ).resolves.toBeUndefined();

    const storedVideos = await runInDurableObject(
      subscription,
      async (_instance, state) => drizzle(state.storage).select().from(videos),
    );
    expect(storedVideos).toHaveLength(1);
  });

  it('does not queue a video that has already been recorded', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    const notification = {
      videoId: 'duplicate-video',
      channelId: youtubeChannelId,
      title: 'A YouTube video',
      publishedAt: '2026-08-07T12:34:56.789Z',
    };

    await subscription.recordVideo(notification);

    await expect(
      subscription.recordVideo(notification),
    ).resolves.toBeUndefined();

    const storedVideos = await runInDurableObject(
      subscription,
      async (_instance, state) => drizzle(state.storage).select().from(videos),
    );
    expect(storedVideos).toHaveLength(1);
  });

  it('queues concurrent notifications for the same video only once', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    const notification = {
      videoId: 'concurrent-video',
      channelId: youtubeChannelId,
      title: 'A YouTube video',
      publishedAt: '2026-08-07T12:34:56.789Z',
    };

    await runInDurableObject(subscription, async (instance, state) => {
      await drizzle(state.storage).insert(subscribers).values({
        channelId: '123456789012345678',
        guildId: '234567890123456789',
      });

      const queueCall = Promise.withResolvers<void>();
      const sendBatch = vi.fn(() => queueCall.promise);
      Object.defineProperty(instance, 'env', {
        configurable: true,
        value: { DISCORD_MESSAGES: { sendBatch } },
      });

      const firstCall = instance.recordVideo(notification);
      await vi.waitFor(() => expect(sendBatch).toHaveBeenCalledOnce());

      await expect(instance.recordVideo(notification)).resolves.toBeUndefined();
      expect(sendBatch).toHaveBeenCalledOnce();

      queueCall.resolve();
      await expect(firstCall).resolves.toBeUndefined();
    });
  });

  it('releases a video claim when queueing fails', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    const notification = {
      videoId: 'retryable-video',
      channelId: youtubeChannelId,
      title: 'A YouTube video',
      publishedAt: '2026-08-07T12:34:56.789Z',
    };

    await runInDurableObject(subscription, async (instance, state) => {
      const database = drizzle(state.storage);
      await database.insert(subscribers).values({
        channelId: '123456789012345678',
        guildId: '234567890123456789',
      });

      const sendBatch = vi
        .fn()
        .mockRejectedValueOnce(new Error('Queue unavailable'))
        .mockResolvedValueOnce(undefined);
      Object.defineProperty(instance, 'env', {
        configurable: true,
        value: { DISCORD_MESSAGES: { sendBatch } },
      });

      await expect(instance.recordVideo(notification)).rejects.toThrow(
        'Queue unavailable',
      );
      await expect(database.select().from(videos)).resolves.toEqual([]);

      await expect(instance.recordVideo(notification)).resolves.toBeUndefined();
      expect(sendBatch).toHaveBeenCalledTimes(2);
      await expect(database.select().from(videos)).resolves.toHaveLength(1);
    });
  });

  it('rejects mismatched channel IDs and invalid timestamps', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);

    await expect(
      runInDurableObject(subscription, (instance: YouTubeSubscription) =>
        instance.recordVideo({
          videoId: 'mismatched-channel',
          channelId: YouTubeChannelId.parse('UCaaaaaaaaaaaaaaaaaaaaaa'),
          title: 'A YouTube video',
          publishedAt: '2026-08-07T12:34:56.789Z',
        }),
      ),
    ).rejects.toThrow('does not match Durable Object');

    const namedSubscription =
      env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    await expect(
      runInDurableObject(namedSubscription, (instance: YouTubeSubscription) =>
        instance.recordVideo({
          videoId: 'invalid-date',
          channelId: youtubeChannelId,
          title: 'A YouTube video',
          publishedAt: 'not-a-date',
        }),
      ),
    ).rejects.toThrow();
  });
});

function randomYouTubeChannelId(): YouTubeChannelId {
  return YouTubeChannelId.parse(
    `UC${crypto.randomUUID().replaceAll('-', '').slice(0, 22)}`,
  );
}

function readSubscribers(
  subscription: DurableObjectStub<YouTubeSubscription>,
): Promise<(typeof subscribers.$inferSelect)[]> {
  return runInDurableObject(subscription, async (_instance, state) =>
    drizzle(state.storage).select().from(subscribers),
  );
}

function createGuildYouTubeSubscriptionKey(
  guildId: string,
  channelId: string,
  youtubeChannelId: string,
): string {
  return `guild:${guildId}:channel:${channelId}:youtube:${youtubeChannelId}`;
}

function createChannelYouTubeSubscriptionKey(
  channelId: string,
  youtubeChannelId: string,
): string {
  return `channel:${channelId}:youtube:${youtubeChannelId}`;
}
