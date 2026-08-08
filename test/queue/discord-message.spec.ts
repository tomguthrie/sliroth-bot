import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiscordMessageDelivery } from '../../src/queue/discord-message';
import {
  deliverDiscordMessageBatch,
  enqueueDiscordMessages,
} from '../../src/queue/discord-message';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '234567890123456789';
const TEST_ENV = {
  ...env,
  DISCORD_BOT_TOKEN: 'test-discord-bot-token',
  PUBLIC_BASE_URL: 'https://bot.example.com',
} satisfies Env;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Discord Queue producer', () => {
  it('does not call Queue when there are no deliveries', async () => {
    const sendBatch = vi.fn();

    await enqueueDiscordMessages({ sendBatch }, []);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('queues all deliveries in one batch', async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const deliveries = [createDelivery('one'), createDelivery('two')];

    await enqueueDiscordMessages({ sendBatch }, deliveries);

    expect(sendBatch).toHaveBeenCalledOnce();
    expect(sendBatch).toHaveBeenCalledWith([
      { body: deliveries[0] },
      { body: deliveries[1] },
    ]);
  });

  it('propagates a Queue failure', async () => {
    const sendBatch = vi.fn().mockRejectedValue(new Error('Queue unavailable'));

    await expect(
      enqueueDiscordMessages({ sendBatch }, [
        createDelivery('one'),
        createDelivery('two'),
      ]),
    ).rejects.toThrow('Queue unavailable');
    expect(sendBatch).toHaveBeenCalledOnce();
  });
});

describe('Discord Queue consumer', () => {
  it('acknowledges a successful delivery', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));

    const result = await consume(createDelivery('success'));

    expect(result.explicitAcks).toEqual(['success']);
    expect(result.retryMessages).toEqual([]);
  });

  it.each([400, 401, 403, 404])(
    'logs and acknowledges permanent HTTP %i failures',
    async (status) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Permanent failure', { status }),
      );

      const result = await consume(createDelivery(`http-${status}`));

      expect(result.explicitAcks).toEqual([`http-${status}`]);
      expect(result.retryMessages).toEqual([]);
    },
  );

  it('logs and acknowledges request validation failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await consume({
      ...createDelivery('invalid'),
      channelId: 'not-a-snowflake',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.explicitAcks).toEqual(['invalid']);
    expect(result.retryMessages).toEqual([]);
  });

  it('retries rate limits using Discord Retry-After', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Rate limited', {
        status: 429,
        headers: { 'retry-after': '2.1' },
      }),
    );

    const delivery = createDelivery('rate-limited');
    const batch = createMessageBatch<DiscordMessageDelivery>(
      'discord-messages',
      [
        {
          id: 'rate-limited',
          timestamp: new Date('2026-08-07T12:34:56.789Z'),
          attempts: 1,
          body: delivery,
        },
      ],
    );
    const [queuedMessage] = batch.messages;
    if (queuedMessage === undefined) {
      throw new Error('Cloudflare did not create the Queue test message');
    }
    const retry = vi.spyOn(queuedMessage, 'retry');
    const ack = vi.spyOn(queuedMessage, 'ack');

    await deliverDiscordMessageBatch(batch, TEST_ENV);

    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 3 });
    expect(ack).not.toHaveBeenCalled();
  });

  it.each([
    [
      'server failure',
      () => Promise.resolve(new Response(null, { status: 503 })),
    ],
    ['network failure', () => Promise.reject(new TypeError('Network error'))],
  ] as const)(
    'retries a %s using the configured delay',
    async (_name, outcome) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockImplementation(outcome);

      const result = await consume(createDelivery('transient'));

      expect(result.retryMessages).toEqual([
        { msgId: 'transient', delaySeconds: undefined },
      ]);
    },
  );
});

function createDelivery(id: string): DiscordMessageDelivery {
  return {
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    message: {
      content: `Message ${id}`,
      nonce: id.padStart(25, '0').slice(-25),
    },
  };
}

async function consume(delivery: DiscordMessageDelivery) {
  const id = delivery.message.content.replace('Message ', '');
  const batch = createMessageBatch<DiscordMessageDelivery>('discord-messages', [
    {
      id,
      timestamp: new Date('2026-08-07T12:34:56.789Z'),
      attempts: 1,
      body: delivery,
    },
  ]);
  const ctx = createExecutionContext();

  await deliverDiscordMessageBatch(batch, TEST_ENV);
  const result: unknown = await getQueueResult(batch, ctx);

  if (!isQueueResult(result)) {
    throw new Error('Cloudflare returned an invalid Queue test result');
  }

  return result;
}

interface QueueResult {
  explicitAcks: string[];
  retryMessages: { msgId: string; delaySeconds?: number }[];
}

function isQueueResult(value: unknown): value is QueueResult {
  if (!isRecord(value)) {
    return false;
  }

  return (
    Array.isArray(value.explicitAcks) &&
    value.explicitAcks.every((id) => typeof id === 'string') &&
    Array.isArray(value.retryMessages) &&
    value.retryMessages.every(
      (retry) =>
        isRecord(retry) &&
        typeof retry.msgId === 'string' &&
        (retry.delaySeconds === undefined ||
          typeof retry.delaySeconds === 'number'),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
