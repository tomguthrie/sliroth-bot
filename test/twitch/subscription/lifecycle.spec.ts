import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  broadcasters,
  streamMessages,
  streams,
  twitchSubscribers,
} from '../../../src/db/twitch-subscription/schema';
import { DiscordSnowflake } from '../../../src/discord';
import type { DiscordMessageDelivery } from '../../../src/discord/queue';
import { TWITCH_STREAM_MESSAGE_RECEIPT } from '../../../src/twitch/subscription/message-receipt';

const BROADCASTER_ID = '123456789012345678';
const GUILD_ID = '234567890123456789';
const CHANNEL_ID = DiscordSnowflake.parse('345678901234567890');
const MESSAGE_ID = DiscordSnowflake.parse('456789012345678901');

beforeEach(async () => {
  await env.TOKEN_STORE.delete('twitch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Twitch stream lifecycle', () => {
  it('refreshes a pending live message before editing it offline', async () => {
    let currentStream = createMockTwitchStream();
    mockTwitchApi(() => currentStream);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1780680480000);
    const batches: DiscordMessageDelivery[][] = [];
    const subscriptionEvents: unknown[] = [];
    const sendSubscriptionEvent = vi.fn<(body: unknown) => Promise<QueueSendResponse>>((body) => {
      subscriptionEvents.push(body);
      return Promise.resolve(queueSendResponse());
    });
    const sendBatch = vi.fn<
      (messages: Iterable<MessageSendRequest<DiscordMessageDelivery>>) => Promise<void>
    >((messages) => {
      batches.push(Array.from(messages, ({ body }) => body));
      return Promise.resolve();
    });
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(`lifecycle-${crypto.randomUUID()}`);

    await runInDurableObject(subscription, async (instance, state) => {
      const database = drizzle(state.storage);
      await database.insert(broadcasters).values({
        id: BROADCASTER_ID,
        login: 'sliroth',
        displayName: 'Sliroth',
        profileImageUrl: 'https://static.example.com/profile.png',
        offlineImageUrl: 'https://static.example.com/offline.png',
      });
      await database.insert(twitchSubscribers).values({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        ping: 'here',
      });
      Object.defineProperty(instance, 'env', {
        configurable: true,
        value: {
          DISCORD_MESSAGES: { sendBatch },
          SUBSCRIPTION_EVENTS: {
            send: sendSubscriptionEvent,
          },
          TOKEN_STORE: env.TOKEN_STORE,
          TWITCH_CLIENT_ID: env.TWITCH_CLIENT_ID,
          TWITCH_CLIENT_SECRET: env.TWITCH_CLIENT_SECRET,
        },
      });

      await instance.streamOnline({
        streamId: '9001',
        broadcasterId: BROADCASTER_ID,
        broadcasterLogin: 'sliroth',
        broadcasterName: 'Sliroth',
        startedAt: '2026-06-05T17:28:00.000Z',
      });

      expect(batches).toHaveLength(1);
      expect(batches[0]?.[0]).toMatchObject({
        operation: 'create',
        channelId: CHANNEL_ID,
        receipt: {
          type: TWITCH_STREAM_MESSAGE_RECEIPT,
          broadcasterId: BROADCASTER_ID,
          streamId: '9001',
        },
        message: {
          content: '@here Sliroth is live now!',
          allowedMentions: { everyone: true },
          embeds: [
            {
              title: 'Summer Game Fest 2026 | !discord !youtube',
              fields: [
                { name: 'Game', value: 'Special Events', inline: true },
                { name: 'Viewers', value: '3', inline: true },
              ],
              thumbnail: {
                url: 'https://static.example.com/42/144x192.jpg',
              },
              image: {
                url: 'https://static.example.com/1280x720.jpg?t=1780680480000',
              },
            },
          ],
          linkButtons: [
            {
              label: 'Watch Stream',
              url: 'https://twitch.tv/sliroth',
            },
          ],
        },
      });

      expect(await state.storage.getAlarm()).not.toBeNull();

      currentStream = createMockTwitchStream({
        game_id: '84',
        game_name: 'Science & Technology',
        title: 'Building a Discord bot',
        viewer_count: 27,
      });
      now.mockReturnValue(1780680540000);
      await instance.channelUpdate(channelUpdateEvent());
      expect(batches).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();

      await instance.recordDiscordMessage('9001', {
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
      });

      expect(batches).toHaveLength(2);
      expect(batches[1]?.[0]).toMatchObject({
        operation: 'edit',
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        message: {
          content: '@here Sliroth is live now!',
          allowedMentions: { everyone: true },
          embeds: [
            {
              title: 'Building a Discord bot',
              fields: [
                {
                  name: 'Game',
                  value: 'Science & Technology',
                  inline: true,
                },
                { name: 'Viewers', value: '27', inline: true },
              ],
              thumbnail: {
                url: 'https://static.example.com/84/144x192.jpg',
              },
              image: {
                url: 'https://static.example.com/1280x720.jpg?t=1780680540000',
              },
              footer: { text: 'Started streaming' },
              timestamp: '2026-06-05T17:28:00.000Z',
            },
          ],
          linkButtons: [
            {
              label: 'Watch Stream',
              url: 'https://twitch.tv/sliroth',
            },
          ],
        },
      });

      await instance.streamOffline(
        {
          streamId: '9001',
          broadcasterId: BROADCASTER_ID,
          broadcasterLogin: 'sliroth',
          broadcasterName: 'Sliroth',
        },
        '2026-06-05T23:51:08.000Z',
      );

      expect(await state.storage.getAlarm()).toBeNull();
      expect(batches).toHaveLength(3);
      expect(batches[2]?.[0]).toMatchObject({
        operation: 'edit',
        message: {
          embeds: [{ url: 'https://twitch.tv/sliroth' }],
          linkButtons: [
            {
              label: 'Watch Channel',
              url: 'https://twitch.tv/sliroth',
            },
          ],
        },
      });
      expect(subscriptionEvents).toEqual([
        {
          kind: 'twitch-vod-lookup',
          broadcasterId: BROADCASTER_ID,
          streamId: '9001',
        },
      ]);
      expect(sendSubscriptionEvent).toHaveBeenCalledWith(subscriptionEvents[0], {
        delaySeconds: 30,
      });

      await instance.recordStreamVod('9001', 'https://twitch.tv/videos/1234567890');

      expect(batches).toHaveLength(4);
      expect(batches[3]?.[0]).toMatchObject({
        operation: 'edit',
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        message: {
          content: 'Sliroth was live.',
          embeds: [
            {
              title: 'Building a Discord bot',
              url: 'https://twitch.tv/videos/1234567890',
              fields: [
                {
                  name: 'Game',
                  value: 'Science & Technology',
                  inline: true,
                },
                { name: 'Duration', value: '6h 23m 8s', inline: true },
              ],
              image: { url: 'https://static.example.com/offline.png' },
              footer: { text: 'Last online' },
              timestamp: '2026-06-05T23:51:08.000Z',
            },
          ],
          linkButtons: [
            {
              label: 'Watch VOD',
              url: 'https://twitch.tv/videos/1234567890',
            },
          ],
        },
      });
      const [storedStream] = await database.select().from(streams);
      const [storedMessage] = await database.select().from(streamMessages);
      expect(storedStream?.revision).toBe(4);
      expect(storedMessage?.enqueuedRevision).toBe(4);
    });
  });

  it('refreshes unchanged live previews repeatedly and catches up pending receipts', async () => {
    let currentStream = createMockTwitchStream();
    mockTwitchApi(() => currentStream);
    const { subscription, sendBatch } = await seedRefresh();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    await subscription.channelUpdate(channelUpdateEvent());
    const first = sendBatch.mock.calls[0]?.[0][0]?.body;
    now.mockReturnValue(Date.now() + 15 * 60_000);
    currentStream = createMockTwitchStream({ viewer_count: 10 });
    await expect(runDurableObjectAlarm(subscription)).resolves.toBe(true);
    const second = sendBatch.mock.calls[1]?.[0][0]?.body;
    expect(second).toMatchObject({
      operation: 'edit',
      messageId: MESSAGE_ID,
      message: {
        embeds: [
          {
            title: currentStream.title,
            image: { url: `https://static.example.com/1280x720.jpg?t=${Date.now()}` },
            fields: [
              { name: 'Game', value: 'Special Events', inline: true },
              { name: 'Viewers', value: '10', inline: true },
            ],
          },
        ],
      },
    });
    expect(second?.message.embeds?.[0]?.image?.url).not.toBe(
      first?.message.embeds?.[0]?.image?.url,
    );
    await runInDurableObject(subscription, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(Date.now() + 15 * 60_000);
      await drizzle(state.storage).update(streamMessages).set({ messageId: null });
    });
    now.mockReturnValue(Date.now() + 15 * 60_000);
    await runDurableObjectAlarm(subscription);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    await subscription.recordDiscordMessage('9001', {
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
    });
    expect(sendBatch).toHaveBeenCalledTimes(3);
    expect(sendBatch.mock.calls[2]?.[0][0]?.body.message.embeds?.[0]?.image?.url).toBe(
      `https://static.example.com/1280x720.jpg?t=${Date.now()}`,
    );
  });

  it.each(['offline', 'untracked', 'ended', 'unsubscribed'] as const)(
    'stops scheduled refreshes when %s',
    async (status) => {
      mockTwitchApi(() =>
        status === 'offline'
          ? undefined
          : createMockTwitchStream({
              id: status === 'untracked' ? '9002' : '9001',
            }),
      );
      const { subscription, sendBatch } = await seedRefresh();
      await runInDurableObject(subscription, async (_instance, state) => {
        const database = drizzle(state.storage);
        if (status === 'ended') {
          await database.update(streams).set({ endedAt: new Date() });
        }
        if (status === 'unsubscribed') {
          await database.delete(twitchSubscribers);
        }
      });
      await expect(runDurableObjectAlarm(subscription)).resolves.toBe(true);
      expect(sendBatch).not.toHaveBeenCalled();
      await runInDurableObject(subscription, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
      });
    },
  );

  it.each(['Twitch', 'queue'] as const)('retries after a %s failure', async (source) => {
    mockTwitchApi(() => createMockTwitchStream());
    const { subscription, sendBatch } = await seedRefresh();
    const failure = new Error('Temporary outage');
    if (source === 'Twitch') {
      vi.mocked(fetch).mockRejectedValueOnce(failure);
    } else {
      sendBatch.mockRejectedValueOnce(failure);
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    await runDurableObjectAlarm(subscription);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'twitch_live_refresh_failed',
        error: expect.objectContaining({ message: failure.message }),
      }),
    );
    await runInDurableObject(subscription, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(Date.now() + 15 * 60_000);
    });
    now.mockReturnValue(Date.now() + 15 * 60_000);
    await runDurableObjectAlarm(subscription);
    expect(sendBatch).toHaveLastReturnedWith(expect.any(Promise));
    expect(sendBatch.mock.calls.at(-1)?.[0][0]?.body.operation).toBe('edit');
  });

  it('resets the timer on channel updates and cancels it after the last unsubscribe', async () => {
    mockTwitchApi(() => createMockTwitchStream());
    const { subscription } = await seedRefresh();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    await subscription.channelUpdate(channelUpdateEvent());
    await runInDurableObject(subscription, async (instance, state) => {
      expect(await state.storage.getAlarm()).toBe(Date.now() + 15 * 60_000);
      vi.spyOn(instance, 'reconcile').mockResolvedValue(undefined);
      await instance.removeSubscriber(CHANNEL_ID);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('does not revive a stream that ends during a refresh', async () => {
    const { subscription, sendBatch } = await seedRefresh();
    await runInDurableObject(subscription, async (instance, state) => {
      mockTwitchApi(() => createMockTwitchStream());
      const fetchMock = vi.mocked(fetch);
      const fetchApi = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith('/games')) {
          await instance.streamOffline(
            {
              streamId: '9001',
              broadcasterId: BROADCASTER_ID,
              broadcasterLogin: 'sliroth',
              broadcasterName: 'Sliroth',
            },
            new Date().toISOString(),
          );
        }
        if (fetchApi === undefined) {
          throw new Error('Missing fetch mock');
        }
        return fetchApi(input, init);
      });
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      const [stream] = await drizzle(state.storage).select().from(streams);
      expect(stream?.endedAt).not.toBeNull();
      expect(sendBatch).toHaveBeenCalledTimes(1);
      expect(sendBatch.mock.calls[0]?.[0][0]?.body.message.embeds?.[0]?.footer?.text).toBe(
        'Last online',
      );
    });
  });

  it.each([
    ['offline', undefined],
    ['a different stream', createMockTwitchStream({ id: '9002' })],
  ] as const)('ignores a channel update for %s', async (_name, liveStream) => {
    mockTwitchApi(() => liveStream);
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(`inactive-${crypto.randomUUID()}`);
    await runInDurableObject(subscription, async (_instance, state) => {
      const database = drizzle(state.storage);
      await database.insert(broadcasters).values({
        id: BROADCASTER_ID,
        login: 'sliroth',
        displayName: 'Sliroth',
        profileImageUrl: 'https://static.example.com/profile.png',
        offlineImageUrl: 'https://static.example.com/offline.png',
      });
      await database.insert(streams).values({
        id: '9001',
        title: 'Original title',
        gameName: 'Special Events',
        viewerCount: 3,
        gameBoxArtUrl: 'https://static.example.com/{width}x{height}.jpg',
        previewImageUrl: 'https://static.example.com/{width}x{height}.jpg',
        startedAt: new Date('2026-06-05T17:28:00.000Z'),
      });
    });

    await subscription.channelUpdate(channelUpdateEvent());

    const [storedStream] = await runInDurableObject(subscription, async (_instance, state) =>
      drizzle(state.storage).select().from(streams),
    );
    expect(storedStream).toMatchObject({
      id: '9001',
      title: 'Original title',
      revision: 1,
    });
  });
});

interface MockTwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
}

function createMockTwitchStream(overrides: Partial<MockTwitchStream> = {}): MockTwitchStream {
  return {
    id: '9001',
    user_id: BROADCASTER_ID,
    user_login: 'sliroth',
    user_name: 'Sliroth',
    game_id: '42',
    game_name: 'Special Events',
    title: 'Summer Game Fest 2026 | !discord !youtube',
    viewer_count: 3,
    started_at: '2026-06-05T17:28:00.000Z',
    thumbnail_url: 'https://static.example.com/{width}x{height}.jpg',
    ...overrides,
  };
}

function channelUpdateEvent() {
  return {
    broadcasterId: BROADCASTER_ID,
    broadcasterLogin: 'sliroth',
    broadcasterName: 'Sliroth',
    title: 'Building a Discord bot',
    language: 'en',
    gameId: '84',
    gameName: 'Science & Technology',
    contentClassificationLabels: [],
  };
}

function mockTwitchApi(getStream: () => MockTwitchStream | undefined): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'id.twitch.tv') {
      return Promise.resolve(Response.json({ access_token: 'token', expires_in: 3600 }));
    }
    if (url.pathname.endsWith('/streams')) {
      const stream = getStream();
      return Promise.resolve(Response.json({ data: stream ? [stream] : [] }));
    }
    if (url.pathname.endsWith('/games')) {
      const gameId = url.searchParams.get('id');
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: gameId,
              name: gameId === '84' ? 'Science & Technology' : 'Special Events',
              box_art_url: `https://static.example.com/${gameId}/{width}x{height}.jpg`,
            },
          ],
        }),
      );
    }
    if (url.pathname.endsWith('/videos')) {
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: '1234567890',
              stream_id: '9001',
              user_id: BROADCASTER_ID,
              user_login: 'sliroth',
              user_name: 'Sliroth',
              title: 'Summer Game Fest 2026 | !discord !youtube',
              description: '',
              created_at: '2026-06-05T17:28:00.000Z',
              published_at: '2026-06-05T17:28:00.000Z',
              url: 'https://twitch.tv/videos/1234567890',
              thumbnail_url: 'https://static.example.com/vod.jpg',
              viewable: 'public',
              view_count: 10,
              language: 'en',
              type: 'archive',
              duration: '6h23m8s',
            },
          ],
        }),
      );
    }
    throw new Error(`Unexpected Twitch request: ${request.url}`);
  });
}

function queueSendResponse(): QueueSendResponse {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}

async function seedRefresh() {
  const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(`refresh-${crypto.randomUUID()}`);
  const sendBatch = vi
    .fn<(messages: MessageSendRequest<DiscordMessageDelivery>[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  await runInDurableObject(subscription, async (instance, state) => {
    const database = drizzle(state.storage);
    await database.insert(broadcasters).values({
      id: BROADCASTER_ID,
      login: 'sliroth',
      displayName: 'Sliroth',
      profileImageUrl: 'https://static.example.com/profile.png',
      offlineImageUrl: 'https://static.example.com/offline.png',
    });
    await database.insert(twitchSubscribers).values({ guildId: GUILD_ID, channelId: CHANNEL_ID });
    await database.insert(streams).values({
      id: '9001',
      title: 'Original title',
      gameName: 'Special Events',
      viewerCount: 3,
      previewImageUrl: 'https://static.example.com/{width}x{height}.jpg',
      startedAt: new Date(),
    });
    await database
      .insert(streamMessages)
      .values({ streamId: '9001', channelId: CHANNEL_ID, messageId: MESSAGE_ID });
    Object.defineProperty(instance, 'env', {
      configurable: true,
      value: {
        ...env,
        DISCORD_MESSAGES: { sendBatch },
        SUBSCRIPTION_EVENTS: {
          send: vi.fn<() => Promise<QueueSendResponse>>().mockResolvedValue(queueSendResponse()),
        },
      },
    });
    await state.storage.setAlarm(Date.now() + 15 * 60_000);
  });
  return { subscription, sendBatch };
}
