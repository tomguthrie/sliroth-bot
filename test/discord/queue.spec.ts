import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiscordMessage } from '../../src/discord';
import {
  createDiscordMessageProcessor,
  enqueueDiscordMessages,
  type DiscordCreateMessageDelivery,
} from '../../src/discord/queue';
import type { QueueMessageContext } from '../../src/queue/message';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '234567890123456789';
const MESSAGE_ID = '345678901234567890';
const TEST_ENV = {
  ...env,
  DISCORD_BOT_TOKEN: 'test-discord-bot-token',
  PUBLIC_BASE_URL: 'https://bot.example.com',
} satisfies Env;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Discord Queue producer', () => {
  it('does not send an empty batch', async () => {
    const sendBatch = vi.fn();

    await enqueueDiscordMessages({ sendBatch }, []);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('sends deliveries in one batch', async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const deliveries = [createDelivery('one'), createDelivery('two')];

    await enqueueDiscordMessages({ sendBatch }, deliveries);

    expect(sendBatch).toHaveBeenCalledWith([
      { body: deliveries[0] },
      { body: deliveries[1] },
    ]);
  });
});

describe('Discord Queue processor', () => {
  it('acknowledges a successful create', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(discordReceipt());

    const result = await createDiscordMessageProcessor([])(
      createDelivery('success'),
      TEST_ENV,
      CONTEXT,
    );

    expect(result).toEqual({ action: 'ack' });
  });

  it('passes an optional receipt to its feature handler', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(discordReceipt());
    const handle = vi.fn().mockResolvedValue(undefined);
    const processor = createDiscordMessageProcessor([
      { type: 'test-receipt', handle },
    ]);
    const delivery = {
      ...createDelivery('receipt'),
      receipt: { type: 'test-receipt', ownerId: 'owner' },
    } satisfies DiscordCreateMessageDelivery;

    const result = await processor(delivery, TEST_ENV, CONTEXT);

    expect(result).toEqual({ action: 'ack' });
    expect(handle).toHaveBeenCalledWith(
      delivery.receipt,
      { channelId: CHANNEL_ID, messageId: MESSAGE_ID },
      TEST_ENV,
    );
  });

  it('rejects duplicate receipt handlers', () => {
    const handler = {
      type: 'duplicate',
      handle: vi.fn().mockResolvedValue(undefined),
    };

    expect(() => createDiscordMessageProcessor([handler, handler])).toThrow(
      'Duplicate Discord message receipt: duplicate',
    );
  });

  it.each([400, 401, 403, 404])(
    'acknowledges permanent HTTP %i failures',
    async (status) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Permanent failure', { status }),
      );

      const result = await createDiscordMessageProcessor([])(
        createDelivery(`http-${status}`),
        TEST_ENV,
        CONTEXT,
      );

      expect(result).toEqual({ action: 'ack' });
    },
  );

  it('uses Discord Retry-After for rate limits', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Rate limited', {
        status: 429,
        headers: { 'retry-after': '2.1' },
      }),
    );

    const result = await createDiscordMessageProcessor([])(
      createDelivery('rate-limited'),
      TEST_ENV,
      CONTEXT,
    );

    expect(result).toEqual({ action: 'retry', delaySeconds: 3 });
  });

  it('retries transient failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Network error'),
    );

    const result = await createDiscordMessageProcessor([])(
      createDelivery('transient'),
      TEST_ENV,
      CONTEXT,
    );

    expect(result).toEqual({ action: 'retry' });
  });
});

function createDelivery(id: string): DiscordCreateMessageDelivery {
  return {
    operation: 'create',
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    message: {
      content: `Message ${id}`,
      nonce: id.padStart(25, '0').slice(-25),
    } satisfies DiscordMessage,
  };
}

function discordReceipt(): Response {
  return Response.json({ id: MESSAGE_ID, channel_id: CHANNEL_ID });
}

const CONTEXT: QueueMessageContext = {
  queue: 'discord-messages',
  messageId: 'message',
  attempt: 1,
  enqueuedAt: new Date('2026-08-07T12:34:56.789Z'),
  startedAt: Date.now(),
};
