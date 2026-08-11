import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  broadcasters,
  streamMessages,
  streams,
  twitchSubscribers,
} from '../../src/db/twitch-subscription/schema';
import { DiscordSnowflake } from '../../src/discord/snowflake';
import type { DiscordMessageDelivery } from '../../src/queue/discord-message';
import { DISCORD_RECEIPT_TWITCH_STREAM } from '../../src/queue/discord-message';

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
    const sendBatch = vi.fn(
      (messages: Iterable<MessageSendRequest<DiscordMessageDelivery>>) => {
        batches.push(Array.from(messages, ({ body }) => body));
        return Promise.resolve();
      },
    );
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      `lifecycle-${crypto.randomUUID()}`,
    );

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
          TOKEN_STORE: env.TOKEN_STORE,
          TWITCH_CLIENT_ID: env.TWITCH_CLIENT_ID,
          TWITCH_CLIENT_SECRET: env.TWITCH_CLIENT_SECRET,
        },
      });

      await instance.streamOnline({
        id: '9001',
        broadcaster_user_id: BROADCASTER_ID,
        broadcaster_user_login: 'sliroth',
        broadcaster_user_name: 'Sliroth',
        type: 'live',
        started_at: '2026-06-05T17:28:00.000Z',
      });

      expect(batches).toHaveLength(1);
      expect(batches[0]?.[0]).toMatchObject({
        operation: 'create',
        channelId: CHANNEL_ID,
        receiptTarget: {
          type: DISCORD_RECEIPT_TWITCH_STREAM,
          broadcasterId: BROADCASTER_ID,
          streamId: '9001',
        },
        message: {
          content: '@here Sliroth is live now! https://twitch.tv/sliroth',
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

      currentStream = createMockTwitchStream({
        game_id: '84',
        game_name: 'Science & Technology',
        title: 'Building a Discord bot',
        viewer_count: 27,
      });
      now.mockReturnValue(1780680540000);
      await instance.channelUpdate(channelUpdateEvent());
      expect(batches).toHaveLength(1);

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
          content: '@here Sliroth is live now! https://twitch.tv/sliroth',
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
          id: '9001',
          broadcaster_user_id: BROADCASTER_ID,
          broadcaster_user_login: 'sliroth',
          broadcaster_user_name: 'Sliroth',
        },
        '2026-06-05T23:51:08.000Z',
      );

      expect(batches).toHaveLength(3);
      expect(batches[2]?.[0]).toMatchObject({
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
      expect(storedStream?.revision).toBe(3);
      expect(storedMessage?.enqueuedRevision).toBe(3);
    });
  });

  it.each([
    ['offline', undefined],
    ['a different stream', createMockTwitchStream({ id: '9002' })],
  ] as const)('ignores a channel update for %s', async (_name, liveStream) => {
    mockTwitchApi(() => liveStream);
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      `inactive-${crypto.randomUUID()}`,
    );
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

    const [storedStream] = await runInDurableObject(
      subscription,
      async (_instance, state) => drizzle(state.storage).select().from(streams),
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

function createMockTwitchStream(
  overrides: Partial<MockTwitchStream> = {},
): MockTwitchStream {
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
    broadcaster_user_id: BROADCASTER_ID,
    broadcaster_user_login: 'sliroth',
    broadcaster_user_name: 'Sliroth',
    title: 'Building a Discord bot',
    language: 'en',
    category_id: '84',
    category_name: 'Science & Technology',
    content_classification_labels: [],
  };
}

function mockTwitchApi(getStream: () => MockTwitchStream | undefined): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'id.twitch.tv') {
      return Promise.resolve(
        Response.json({ access_token: 'token', expires_in: 3600 }),
      );
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
              created_at: '2026-06-05T17:28:00.000Z',
              published_at: '2026-06-05T17:28:00.000Z',
              url: 'https://twitch.tv/videos/1234567890',
              thumbnail_url: 'https://static.example.com/vod.jpg',
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
