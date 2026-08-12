import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  runInDurableObject,
} from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { broadcasters, streams } from '../../src/db/twitch-subscription/schema';
import {
  deliverSubscriptionEventBatch,
  type TwitchVodLookupDelivery,
} from '../../src/queue/subscription-event';
import { TwitchBroadcasterId, TwitchStreamId } from '../../src/twitch/data';

const STREAM_ID = TwitchStreamId.parse('9001');

beforeEach(async () => {
  await env.TOKEN_STORE.delete('twitch');
  vi.restoreAllMocks();
});

describe('subscription event Queue consumer', () => {
  it.each([
    [1, 60],
    [2, 120],
    [3, 240],
    [4, 480],
  ])('defers missing Twitch VODs on attempt %i', async (attempts, delay) => {
    mockMissingVod();
    const { queueResult, retryDelaySeconds } =
      await consumeMissingVod(attempts);

    expect(queueResult.explicitAcks).toEqual([]);
    expect(queueResult.retryMessages).toEqual([{ msgId: `vod-${attempts}` }]);
    expect(retryDelaySeconds).toBe(delay);
  });

  it('acknowledges a missing Twitch VOD after retry delays are exhausted', async () => {
    mockMissingVod();
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const { queueResult, retryDelaySeconds } = await consumeMissingVod(5);

    expect(queueResult.explicitAcks).toEqual(['vod-5']);
    expect(queueResult.retryMessages).toEqual([]);
    expect(retryDelaySeconds).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'twitch_vod_lookup_exhausted',
        streamId: STREAM_ID,
        attempt: 5,
      }),
    );
  });
});

async function consumeMissingVod(attempts: number): Promise<{
  queueResult: QueueResult;
  retryDelaySeconds: number | undefined;
}> {
  const broadcasterId = TwitchBroadcasterId.parse(
    `12345678901234567${attempts}`,
  );
  const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId);
  await runInDurableObject(subscription, async (_instance, state) => {
    const database = drizzle(state.storage);
    await database.insert(broadcasters).values({
      id: broadcasterId,
      login: 'sliroth',
      displayName: 'Sliroth',
      profileImageUrl: 'https://example.com/profile.png',
      offlineImageUrl: 'https://example.com/offline.png',
    });
    await database.insert(streams).values({
      id: STREAM_ID,
      title: 'Finished stream',
      gameName: 'Special Events',
      viewerCount: 3,
      previewImageUrl: 'https://example.com/preview.jpg',
      startedAt: new Date('2026-08-11T18:00:00Z'),
      endedAt: new Date('2026-08-11T19:00:00Z'),
    });
  });
  const delivery: TwitchVodLookupDelivery = {
    kind: 'twitch-vod-lookup',
    broadcasterId,
    streamId: STREAM_ID,
  };
  const batch = createMessageBatch<TwitchVodLookupDelivery>(
    'subscription-events',
    [
      {
        id: `vod-${attempts}`,
        timestamp: new Date('2026-08-11T19:00:00Z'),
        attempts,
        body: delivery,
      },
    ],
  );
  const [queuedMessage] = batch.messages;
  if (queuedMessage === undefined) {
    throw new Error('Cloudflare did not create the Queue test message');
  }
  const retry = vi.spyOn(queuedMessage, 'retry');
  const ctx = createExecutionContext();

  await deliverSubscriptionEventBatch(batch, env);
  const result: unknown = await getQueueResult(batch, ctx);
  if (!isQueueResult(result)) {
    throw new Error('Cloudflare returned an invalid Queue test result');
  }
  return {
    queueResult: result,
    retryDelaySeconds: retry.mock.calls[0]?.[0]?.delaySeconds,
  };
}

function mockMissingVod(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'id.twitch.tv') {
      return Promise.resolve(
        Response.json({ access_token: 'token', expires_in: 3600 }),
      );
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
}

interface QueueResult {
  explicitAcks: string[];
  retryMessages: { msgId: string; delaySeconds?: number }[];
}

function isQueueResult(value: unknown): value is QueueResult {
  return (
    isRecord(value) &&
    Array.isArray(value.explicitAcks) &&
    Array.isArray(value.retryMessages)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
