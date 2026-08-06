import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createYouTubeTopicUrl,
  YOUTUBE_WEBSUB_HUB_URL,
} from '../../src/youtube/websub';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('YouTubeSubscription', () => {
  it('initializes and preserves subscription state', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    const first = await subscription.ensureInitialized('UC_TEST_CHANNEL_ID');
    const second = await subscription.ensureInitialized('UC_TEST_CHANNEL_ID');

    expect(second).toEqual(first);
  });

  it('requests a subscription and records pending state', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const body = await request.formData();

        expect(request.url).toBe(YOUTUBE_WEBSUB_HUB_URL);
        expect(request.method).toBe('POST');

        expect(body.get('hub.mode')).toBe('subscribe');

        expect(body.get('hub.secret')).toBe(env.YOUTUBE_WEBSUB_SECRET);

        const topic = body.get('hub.topic');

        if (typeof topic !== 'string') {
          throw new Error('Expected hub.topic to be a string');
        }

        const topicUrl = new URL(topic);

        expect(topicUrl.origin).toBe('https://www.youtube.com');
        expect(topicUrl.pathname).toBe('/feeds/videos.xml');

        expect(topicUrl.searchParams.get('channel_id')).toBe(
          env.YOUTUBE_CHANNEL_ID,
        );

        const expectedCallbackUrl = new URL(
          `/youtube/websub/${encodeURIComponent(env.YOUTUBE_CALLBACK_TOKEN)}`,
          env.PUBLIC_BASE_URL,
        );

        expect(body.get('hub.callback')).toBe(expectedCallbackUrl.toString());

        return new Response(null, { status: 204 });
      });

    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    const first = await subscription.requestSubscription();
    const second = await subscription.requestSubscription();

    expect(first.schemaVersion).toBe(1);
    expect(first.phase).toBe('pending');
    expect(first.channelId).toBe(env.YOUTUBE_CHANNEL_ID);
    expect(typeof first.createdAtMs).toBe('number');
    expect(typeof first.requestedAtMs).toBe('number');
    expect(first.expiresAtMs).toBeNull();

    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('confirms a pending subscription lease', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    await subscription.requestSubscription();

    const leaseSeconds = 86_400;
    const beforeConfirmationMs = Date.now();

    const rejected = await subscription.confirmSubscription(
      'https://example.com/wrong-topic',
      leaseSeconds,
    );

    expect(rejected).toBeNull();

    const active = await subscription.confirmSubscription(
      createYouTubeTopicUrl(env.YOUTUBE_CHANNEL_ID),
      leaseSeconds,
    );

    if (active === null) {
      throw new Error('Expected subscription confirmation to succeed');
    }

    expect(active.phase).toBe('active');
    expect(active.requestedAtMs).toBeNull();
    expect(typeof active.expiresAtMs).toBe('number');

    if (active.expiresAtMs === null) {
      throw new Error('Expected an active subscriptoin to have an expiration');
    }

    expect(active.expiresAtMs).toBeGreaterThanOrEqual(
      beforeConfirmationMs + leaseSeconds * 1000,
    );

    expect(active.expiresAtMs).toBeLessThanOrEqual(
      Date.now() + leaseSeconds * 1000,
    );

    const repeated = await subscription.confirmSubscription(
      createYouTubeTopicUrl(env.YOUTUBE_CHANNEL_ID),
      leaseSeconds,
    );

    expect(repeated).toBeNull();
  });
});
