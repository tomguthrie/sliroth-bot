import { env, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { streams } from '../../../src/db/twitch-subscription/schema';
import type { QueueMessageContext } from '../../../src/queue/message';
import { TwitchVideo } from '../../../src/twitch/client';
import {
  processTwitchSubscriptionEvent,
  type TwitchVodLookupDelivery,
} from '../../../src/twitch/subscription/queue';

const BROADCASTER_ID = '123456789012345678';
const STREAM_ID = '9001';
const DELIVERY: TwitchVodLookupDelivery = {
  kind: 'twitch-vod-lookup',
  broadcasterId: BROADCASTER_ID,
  streamId: STREAM_ID,
};

beforeEach(async () => {
  await env.TOKEN_STORE.delete('twitch');
  vi.restoreAllMocks();
});

describe('Twitch subscription Queue processing', () => {
  it.each([
    [1, 60],
    [2, 120],
    [3, 240],
    [4, 480],
  ])('defers missing Twitch VODs on attempt %i', async (attempt, delay) => {
    mockTwitchVideos([]);
    const getByName = vi.spyOn(env.TWITCH_SUBSCRIPTIONS, 'getByName');

    const result = await processTwitchSubscriptionEvent(
      DELIVERY,
      env,
      createContext(attempt),
    );

    expect(result).toEqual({ action: 'retry', delaySeconds: delay });
    expect(getByName).not.toHaveBeenCalled();
  });

  it('acknowledges a missing Twitch VOD after retries are exhausted', async () => {
    mockTwitchVideos([]);
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const result = await processTwitchSubscriptionEvent(
      DELIVERY,
      env,
      createContext(5),
    );

    expect(result).toEqual({ action: 'ack' });
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'twitch_vod_lookup_exhausted',
        streamId: STREAM_ID,
        attempt: 5,
      }),
    );
  });

  it('records a discovered VOD in the broadcaster object', async () => {
    const vodUrl = 'https://twitch.tv/videos/1234567890';
    mockTwitchVideos([createTwitchVideo(vodUrl)]);
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(BROADCASTER_ID);
    await runInDurableObject(subscription, async (_instance, state) => {
      await drizzle(state.storage)
        .insert(streams)
        .values({
          id: STREAM_ID,
          title: 'Finished stream',
          gameName: 'Special Events',
          viewerCount: 3,
          previewImageUrl: 'https://example.com/preview.jpg',
          startedAt: new Date('2026-08-11T18:00:00Z'),
          endedAt: new Date('2026-08-11T19:00:00Z'),
        });
    });

    const result = await processTwitchSubscriptionEvent(
      DELIVERY,
      env,
      createContext(1),
    );

    expect(result).toEqual({ action: 'ack' });
    const [stored] = await runInDurableObject(
      subscription,
      async (_instance, state) =>
        drizzle(state.storage)
          .select()
          .from(streams)
          .where(eq(streams.id, STREAM_ID)),
    );
    expect(stored?.vodUrl).toBe(vodUrl);
  });
});

function createContext(attempt: number): QueueMessageContext {
  return {
    queue: 'subscription-events',
    messageId: `vod-${attempt}`,
    attempt,
    enqueuedAt: new Date('2026-08-11T19:00:00Z'),
    startedAt: Date.now(),
  };
}

type TwitchVideoWire = z.input<typeof TwitchVideo>;

function mockTwitchVideos(videos: readonly TwitchVideoWire[]): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'id.twitch.tv') {
      return Promise.resolve(
        Response.json({ access_token: 'token', expires_in: 3600 }),
      );
    }
    return Promise.resolve(Response.json({ data: videos }));
  });
}

function createTwitchVideo(url: string): TwitchVideoWire {
  return {
    id: '1234567890',
    stream_id: STREAM_ID,
    user_id: BROADCASTER_ID,
    user_login: 'sliroth',
    user_name: 'Sliroth',
    title: 'Finished stream',
    description: '',
    created_at: '2026-08-11T18:00:00Z',
    published_at: '2026-08-11T18:00:00Z',
    url,
    thumbnail_url: 'https://example.com/thumbnail.jpg',
    viewable: 'public',
    view_count: 3,
    language: 'en',
    type: 'archive',
    duration: '1h0m0s',
  };
}
