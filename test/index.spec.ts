import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { videos } from '../src/db/youtube-subscription/schema';
import { YouTubeChannelId } from '../src/youtube/data';
import { createYouTubeTopicUrl } from '../src/youtube/websub';

const GUILD_ID = '123456789012345678';
const DISCORD_CHANNEL_ID = '234567890123456789';
const YOUTUBE_CHANNEL_TITLE = 'YouTube channel';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(null, { status: 202 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker', () => {
  it.each([
    ['GET', 'https://example.com/'],
    ['POST', 'https://example.com/youtube/websub'],
    ['DELETE', 'https://example.com/anything?query=value'],
  ])('returns 404 for %s %s', async (method, url) => {
    const response = await exports.default.fetch(url, { method });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: 404, error: 'Not Found' });
  });

  it('confirms a valid WebSub subscription intent', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    await env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId).addSubscriber({
      guildId: GUILD_ID,
      channelId: DISCORD_CHANNEL_ID,
      channelTitle: YOUTUBE_CHANNEL_TITLE,
    });
    const query = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.topic': createYouTubeTopicUrl(youtubeChannelId),
      'hub.challenge': 'challenge-123',
      'hub.lease_seconds': '1000',
    });

    const response = await exports.default.fetch(
      `https://example.com/youtube/websub/${youtubeChannelId}?${query.toString()}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      'challenge-123',
    );
  });

  it('rejects malformed and stale WebSub intents', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const malformed = await exports.default.fetch(
      `https://example.com/youtube/websub/${youtubeChannelId}?hub.mode=subscribe`,
    );

    const staleQuery = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.topic': createYouTubeTopicUrl(youtubeChannelId),
      'hub.challenge': 'challenge-123',
      'hub.lease_seconds': '1000',
    });
    const stale = await exports.default.fetch(
      `https://example.com/youtube/websub/${youtubeChannelId}?${staleQuery.toString()}`,
    );

    expect(malformed.status).toBe(400);
    expect(stale.status).toBe(404);
  });

  it('authenticates and records a WebSub notification', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: DISCORD_CHANNEL_ID,
      channelTitle: YOUTUBE_CHANNEL_TITLE,
    });
    const secret = await runInDurableObject(
      subscription,
      async (_instance, state) => state.storage.get<string>('websub:secret'),
    );
    if (secret === undefined) {
      throw new Error('YouTubeSubscription did not create a WebSub secret');
    }

    const body = createNotification(youtubeChannelId);
    const response = await exports.default.fetch(
      `https://example.com/youtube/websub/${youtubeChannelId}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/atom+xml',
          'x-hub-signature': await createSignature(body, secret),
        },
        body,
      },
    );

    expect(response.status).toBe(204);
    const storedVideos = await runInDurableObject(
      subscription,
      async (_instance, state) => drizzle(state.storage).select().from(videos),
    );
    expect(storedVideos).toEqual([
      expect.objectContaining({
        id: 'video-id',
        title: 'A YouTube video',
      }),
    ]);
  });

  it('rejects a notification with an invalid signature', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    await env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId).addSubscriber({
      guildId: GUILD_ID,
      channelId: DISCORD_CHANNEL_ID,
      channelTitle: YOUTUBE_CHANNEL_TITLE,
    });

    const response = await exports.default.fetch(
      `https://example.com/youtube/websub/${youtubeChannelId}`,
      {
        method: 'POST',
        headers: { 'x-hub-signature': `sha1=${'00'.repeat(20)}` },
        body: createNotification(youtubeChannelId),
      },
    );

    expect(response.status).toBe(401);
  });
});

function randomYouTubeChannelId(): YouTubeChannelId {
  return YouTubeChannelId.parse(
    `UC${crypto.randomUUID().replaceAll('-', '').slice(0, 22)}`,
  );
}

function createNotification(channelId: string): string {
  return `
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
          xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <yt:videoId>video-id</yt:videoId>
        <yt:channelId>${channelId}</yt:channelId>
        <title>A YouTube video</title>
        <published>2026-08-08T12:00:00Z</published>
      </entry>
    </feed>
  `;
}

async function createSignature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha1=${hex}`;
}
