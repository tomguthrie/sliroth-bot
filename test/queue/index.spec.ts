import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deliverQueueBatch, type WorkerQueueMessage } from '../../src/queue';
import { deliverQueueMessages } from '../../src/queue/message';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Queue message delivery', () => {
  it('applies acknowledge and delayed retry dispositions', async () => {
    const batch = createMessageBatch('test-queue', [
      createTestMessage('ack'),
      createTestMessage('retry'),
    ]);
    const retryMessage = batch.messages[1];
    if (retryMessage === undefined) throw new Error('Missing retry message');
    const retry = vi.spyOn(retryMessage, 'retry');

    await deliverQueueMessages(batch, env, (body) =>
      Promise.resolve(
        body === 'ack'
          ? { action: 'ack' }
          : { action: 'retry', delaySeconds: 30 },
      ),
    );

    const result: unknown = await getQueueResult(
      batch,
      createExecutionContext(),
    );
    if (!isQueueResult(result)) throw new Error('Invalid Queue result');
    expect(result.explicitAcks).toEqual(['ack']);
    expect(result.retryMessages).toEqual([{ msgId: 'retry' }]);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it('retries a message when its processor throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = createMessageBatch('test-queue', [createTestMessage('bad')]);

    await deliverQueueMessages(batch, env, () => {
      throw new Error('Invalid message');
    });

    const result: unknown = await getQueueResult(
      batch,
      createExecutionContext(),
    );
    if (!isQueueResult(result)) throw new Error('Invalid Queue result');
    expect(result.retryMessages).toEqual([
      { msgId: 'bad', delaySeconds: undefined },
    ]);
  });

  it('retries an unknown physical queue as a batch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = createMessageBatch<WorkerQueueMessage>('unknown-queue', [
      {
        id: 'unknown',
        timestamp: new Date('2026-08-07T12:34:56.789Z'),
        attempts: 1,
        body: {
          kind: 'youtube-video',
          channelId: 'youtube-channel',
          notification: {
            videoId: 'video',
            channelId: 'youtube-channel',
            title: 'Video',
            publishedAt: '2026-08-07T12:34:56.789Z',
          },
        },
      },
    ]);

    await deliverQueueBatch(batch, env);

    const result: unknown = await getQueueResult(
      batch,
      createExecutionContext(),
    );
    if (!isQueueResult(result)) throw new Error('Invalid Queue result');
    expect(result.retryBatch.retry).toBe(true);
  });

  it('retries a provider message delivered to the wrong known queue', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = createMessageBatch<WorkerQueueMessage>('discord-messages', [
      {
        id: 'misrouted',
        timestamp: new Date('2026-08-07T12:34:56.789Z'),
        attempts: 1,
        body: {
          kind: 'youtube-video',
          channelId: 'youtube-channel',
          notification: {
            videoId: 'video',
            channelId: 'youtube-channel',
            title: 'Video',
            publishedAt: '2026-08-07T12:34:56.789Z',
          },
        },
      },
    ]);

    await deliverQueueBatch(batch, env);

    const result: unknown = await getQueueResult(
      batch,
      createExecutionContext(),
    );
    if (!isQueueResult(result)) throw new Error('Invalid Queue result');
    expect(result.retryMessages).toEqual([
      { msgId: 'misrouted', delaySeconds: undefined },
    ]);
  });
});

function createTestMessage(body: string) {
  return {
    id: body,
    timestamp: new Date('2026-08-07T12:34:56.789Z'),
    attempts: 1,
    body,
  };
}

interface QueueResult {
  explicitAcks: string[];
  retryMessages: { msgId: string; delaySeconds?: number }[];
  retryBatch: { retry: boolean };
}

function isQueueResult(value: unknown): value is QueueResult {
  return (
    isRecord(value) &&
    Array.isArray(value.explicitAcks) &&
    Array.isArray(value.retryMessages) &&
    isRecord(value.retryBatch) &&
    typeof value.retryBatch.retry === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
