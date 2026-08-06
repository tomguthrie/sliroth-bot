import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createYouTubeTopicUrl,
  YOUTUBE_WEBSUB_HUB_URL,
} from '../../src/youtube/websub';

import type {
  StoredVideo,
  SubscriptionState,
  YouTubeSubscription,
} from '../../src/durable/youtube-subscription';
import type { YouTubeVideoNotification } from '../../src/youtube/notification';

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

  it('records videos published before initialization as baseline', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );
    const createdAtMs = Date.parse('2026-08-06T12:00:00Z');
    const notification = createNotification({
      videoId: 'baseline-video',
      publishedAt: '2026-08-06T11:00:00Z',
    });

    await runInDurableObject(subscription, (_instance, state) => {
      state.storage.kv.put(
        'subscription',
        createActiveSubscription(createdAtMs),
      );
    });

    const pending = await subscription.recordNotifications([notification]);

    expect(pending).toEqual([]);

    const stored = await runInDurableObject(subscription, (_instance, state) =>
      state.storage.kv.get<StoredVideo>('video:baseline-video'),
    );

    expect(stored).toMatchObject({
      schemaVersion: 1,
      notification,
      status: 'baseline',
    });
    expect(typeof stored?.firstSeenAtMs).toBe('number');
  });

  it('records videos published after initialization as pending', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );
    const createdAtMs = Date.parse('2026-08-06T12:00:00Z');
    const notification = createNotification({
      videoId: 'new-video',
      publishedAt: '2026-08-06T13:00:00Z',
    });

    await runInDurableObject(subscription, (_instance, state) => {
      state.storage.kv.put(
        'subscription',
        createActiveSubscription(createdAtMs),
      );
    });

    const pending = await subscription.recordNotifications([notification]);

    expect(pending).toEqual([notification]);

    const stored = await runInDurableObject(subscription, (_instance, state) =>
      state.storage.kv.get<StoredVideo>('video:new-video'),
    );

    expect(stored).toMatchObject({
      schemaVersion: 1,
      notification,
      status: 'pending',
    });
    expect(typeof stored?.firstSeenAtMs).toBe('number');
  });

  it('returns each video only once', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );
    const createdAtMs = Date.parse('2026-08-06T12:00:00Z');
    const notification = createNotification({
      videoId: 'duplicate-video',
      publishedAt: '2026-08-06T13:00:00Z',
    });

    await runInDurableObject(subscription, (_instance, state) => {
      state.storage.kv.put(
        'subscription',
        createActiveSubscription(createdAtMs),
      );
    });

    const first = await subscription.recordNotifications([
      notification,
      notification,
    ]);
    const second = await subscription.recordNotifications([notification]);

    expect(first).toEqual([notification]);
    expect(second).toEqual([]);
  });

  it('rejects notifications for a different channel before storing videos', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );
    const createdAtMs = Date.parse('2026-08-06T12:00:00Z');
    const valid = createNotification({
      videoId: 'valid-video',
      publishedAt: '2026-08-06T13:00:00Z',
    });
    const wrongChannel = createNotification({
      videoId: 'wrong-channel-video',
      channelId: 'UC_OTHER_CHANNEL_ID',
      publishedAt: '2026-08-06T13:00:00Z',
    });

    await runInDurableObject(subscription, (_instance, state) => {
      state.storage.kv.put(
        'subscription',
        createActiveSubscription(createdAtMs),
      );
    });

    await runInDurableObject(subscription, (instance: YouTubeSubscription) => {
      expect(() => instance.recordNotifications([valid, wrongChannel])).toThrow(
        'YouTube notification belongs to a different channel',
      );
    });

    const stored = await runInDurableObject(subscription, (_instance, state) =>
      state.storage.kv.get<StoredVideo>('video:valid-video'),
    );

    expect(stored).toBeUndefined();
  });

  it('waits while subscription verification is still fresh', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    const nowMs = Date.now();
    const requestedAtMs = nowMs - 29 * 60 * 1000;

    await runInDurableObject(subscription, (_instance, state) => {
      const pending: SubscriptionState = {
        schemaVersion: 1,
        phase: 'pending',
        channelId: env.YOUTUBE_CHANNEL_ID,
        createdAtMs: nowMs,
        requestedAtMs,
        renewsAtMs: null,
        expiresAtMs: null,
      };

      state.storage.kv.put('subscription', pending);
    });

    const result = await subscription.reconcileSubscription();

    expect(result.phase).toBe('pending');
    expect(result.requestedAtMs).toBe(requestedAtMs);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('retries when subscription verification has timed out', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 204 })),
      );

    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    const nowMs = Date.now();
    const staleRequestedAtMs = nowMs - 31 * 60 * 1000;

    await runInDurableObject(subscription, (_instance, state) => {
      const pending: SubscriptionState = {
        schemaVersion: 1,
        phase: 'pending',
        channelId: env.YOUTUBE_CHANNEL_ID,
        createdAtMs: nowMs,
        requestedAtMs: staleRequestedAtMs,
        renewsAtMs: null,
        expiresAtMs: null,
      };

      state.storage.kv.put('subscription', pending);
    });

    const result = await subscription.reconcileSubscription();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.phase).toBe('pending');
    expect(result.requestedAtMs).not.toBeNull();

    expect(result.requestedAtMs).toBeGreaterThan(staleRequestedAtMs);
  });

  it('waits while an active subscription does not need renewal', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    const nowMs = Date.now();

    await runInDurableObject(subscription, (_instance, state) => {
      const active: SubscriptionState = {
        schemaVersion: 1,
        phase: 'active',
        channelId: env.YOUTUBE_CHANNEL_ID,
        createdAtMs: nowMs,
        requestedAtMs: null,
        renewsAtMs: nowMs + 60 * 60 * 1000,
        expiresAtMs: nowMs + 2 * 60 * 60 * 1000,
      };

      state.storage.kv.put('subscription', active);
    });

    const result = await subscription.reconcileSubscription();

    expect(result.phase).toBe('active');
    expect(result.requestedAtMs).toBeNull();
    expect(result.renewsAtMs).toBe(nowMs + 60 * 60 * 1000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requests renewal when an active subscription is due', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 204 })),
      );

    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    const nowMs = Date.now();

    await runInDurableObject(subscription, (_instance, state) => {
      const active: SubscriptionState = {
        schemaVersion: 1,
        phase: 'active',
        channelId: env.YOUTUBE_CHANNEL_ID,
        createdAtMs: nowMs,
        requestedAtMs: null,
        renewsAtMs: nowMs - 1,
        expiresAtMs: nowMs + 60 * 60 * 1000,
      };

      state.storage.kv.put('subscription', active);
    });

    const result = await subscription.reconcileSubscription();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.phase).toBe('active');
    expect(result.requestedAtMs).not.toBeNull();
    expect(result.requestedAtMs).toBeGreaterThanOrEqual(nowMs);
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
    expect(first.renewsAtMs).toBeNull();
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
    expect(typeof active.renewsAtMs).toBe('number');
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

  it('preserves confirmation completed while the request is in flight', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    await runInDurableObject(
      subscription,
      async (instance: YouTubeSubscription) => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
          const active = instance.confirmSubscription(
            createYouTubeTopicUrl(env.YOUTUBE_CHANNEL_ID),
            86_400,
          );

          if (active === null) {
            throw new Error(
              'Expected verification during the hub request to succeed',
            );
          }

          return Promise.resolve(new Response(null, { status: 204 }));
        });

        const result = await instance.requestSubscription();

        expect(result.phase).toBe('active');
        expect(result.requestedAtMs).toBeNull();
        expect(typeof result.renewsAtMs).toBe('number');
        expect(typeof result.expiresAtMs).toBe('number');
      },
    );
  });

  it('restores state when the hub rejects the requset', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    await runInDurableObject(
      subscription,
      async (instance: YouTubeSubscription) => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
          Promise.resolve(
            new Response('temporarily unavailable', {
              status: 503,
              headers: {
                'content-type': 'text/plain',
              },
            }),
          ),
        );

        await expect(instance.requestSubscription()).rejects.toThrow(
          'YouTube WebSub hub rejected the subscription with HTTP 503',
        );

        const restored = instance.ensureInitialized(env.YOUTUBE_CHANNEL_ID);

        expect(restored.phase).toBe('uninitialized');
        expect(restored.requestedAtMs).toBeNull();
        expect(restored.renewsAtMs).toBeNull();
        expect(restored.expiresAtMs).toBeNull();
      },
    );
  });
});

function createActiveSubscription(createdAtMs: number): SubscriptionState {
  return {
    schemaVersion: 1,
    phase: 'active',
    channelId: env.YOUTUBE_CHANNEL_ID,
    createdAtMs,
    requestedAtMs: null,
    renewsAtMs: createdAtMs + 60 * 60 * 1000,
    expiresAtMs: createdAtMs + 2 * 60 * 60 * 1000,
  };
}

function createNotification(
  overrides: Partial<YouTubeVideoNotification> = {},
): YouTubeVideoNotification {
  return {
    videoId: 'video-123',
    channelId: env.YOUTUBE_CHANNEL_ID,
    title: 'Test video',
    publishedAt: '2026-08-06T13:00:00Z',
    ...overrides,
  };
}
