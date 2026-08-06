import { env, exports } from 'cloudflare:workers';
import {
  createExecutionContext,
  createScheduledController,
  reset,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SubscriptionState } from '../src/durable/youtube-subscription';
import worker, { YOUTUBE_SUBSCRIPTION_NAME } from '../src/index';
import {
  createYouTubeCallbackUrl,
  createYouTubeTopicUrl,
} from '../src/youtube/websub';

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('worker', () => {
  it('returns 404 for unknown routes', async () => {
    const response = await exports.default.fetch('https://example.com/');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });

  it('confirms a pending YouTube subscription', async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      YOUTUBE_SUBSCRIPTION_NAME,
    );

    const nowMs = Date.now();

    await runInDurableObject(subscription, (_instance, state) => {
      const pending: SubscriptionState = {
        schemaVersion: 1,
        phase: 'pending',
        channelId: env.YOUTUBE_CHANNEL_ID,
        createdAtMs: nowMs,
        requestedAtMs: nowMs,
        renewsAtMs: null,
        expiresAtMs: null,
      };

      state.storage.kv.put('subscription', pending);
    });

    const leaseSeconds = 86_400;
    const challenge = 'test-websub-challenge';

    const callbackUrl = new URL(
      createYouTubeCallbackUrl(env.PUBLIC_BASE_URL, env.YOUTUBE_CALLBACK_TOKEN),
    );

    callbackUrl.searchParams.set('hub.mode', 'subscribe');
    callbackUrl.searchParams.set(
      'hub.topic',
      createYouTubeTopicUrl(env.YOUTUBE_CHANNEL_ID),
    );
    callbackUrl.searchParams.set('hub.challenge', challenge);
    callbackUrl.searchParams.set('hub.lease_seconds', leaseSeconds.toString());

    const response = await exports.default.fetch(callbackUrl.toString());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(challenge);

    const persisted = await runInDurableObject(
      subscription,
      (_instance, state) =>
        state.storage.kv.get<SubscriptionState>('subscription'),
    );

    if (persisted === undefined) {
      throw new Error('Expected subscription state to be persisted');
    }

    expect(persisted.phase).toBe('active');
    expect(persisted.requestedAtMs).toBeNull();
    expect(typeof persisted.renewsAtMs).toBe('number');
    expect(typeof persisted.expiresAtMs).toBe('number');

    if (persisted.expiresAtMs === null) {
      throw new Error('Expected active subscription to have an expiration');
    }

    expect(persisted.expiresAtMs).toBeGreaterThanOrEqual(
      nowMs + leaseSeconds * 1000,
    );

    expect(persisted.expiresAtMs).toBeLessThanOrEqual(
      Date.now() + leaseSeconds * 1000,
    );
  });

  it('accepts a correctly signed YouTube notification', async () => {
    const callbackUrl = createYouTubeCallbackUrl(
      env.PUBLIC_BASE_URL,
      env.YOUTUBE_CALLBACK_TOKEN,
    );
    const body = Uint8Array.from(
      new TextEncoder().encode('<feed>test</feed>'),
    ).buffer;
    const signature = await createSignature(body, env.YOUTUBE_WEBSUB_SECRET);

    const response = await exports.default.fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/atom+xml',
        'x-hub-signature': signature,
      },
      body,
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('rejects an unsigned YouTube notification', async () => {
    const callbackUrl = createYouTubeCallbackUrl(
      env.PUBLIC_BASE_URL,
      env.YOUTUBE_CALLBACK_TOKEN,
    );

    const response = await exports.default.fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/atom+xml',
      },
      body: '<feed>test</feed>',
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  it('rejects unsupported methods on the YouTube callback', async () => {
    const callbackUrl = createYouTubeCallbackUrl(
      env.PUBLIC_BASE_URL,
      env.YOUTUBE_CALLBACK_TOKEN,
    );

    const response = await exports.default.fetch(callbackUrl, {
      method: 'PUT',
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST');
    expect(await response.text()).toBe('Method Not Allowed');
  });

  it('initializes the YouTube subscription on schedule', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const controller = createScheduledController({
      chron: '*/15 * * * *',
      scheduleTime: new Date(0),
    });

    const ctx = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      YOUTUBE_SUBSCRIPTION_NAME,
    );

    const persisted = await runInDurableObject(
      subscription,
      (_instance, state) =>
        state.storage.kv.get<SubscriptionState>('subscription'),
    );

    expect(persisted).toMatchObject({
      schemaVersion: 1,
      phase: 'pending',
      channelId: env.YOUTUBE_CHANNEL_ID,
      renewsAtMs: null,
      expiresAtMs: null,
    });

    expect(typeof persisted?.createdAtMs).toBe('number');
    expect(typeof persisted?.requestedAtMs).toBe('number');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

async function createSignature(
  body: ArrayBuffer,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-1',
    },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, body);

  const signatureHex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return `sha1=${signatureHex}`;
}
