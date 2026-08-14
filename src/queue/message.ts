import { toLoggableError } from '../log';

export type QueueMessageDisposition =
  { action: 'ack' } | { action: 'retry'; delaySeconds?: number };

export interface QueueMessageContext {
  queue: string;
  messageId: string;
  attempt: number;
  enqueuedAt: Date;
  startedAt: number;
}

export type QueueMessageProcessor<T> = (
  body: T,
  env: Env,
  context: QueueMessageContext,
) => Promise<QueueMessageDisposition>;

/** Processes a Queue batch sequentially and applies each returned disposition. */
export async function deliverQueueMessages<T>(
  batch: MessageBatch<T>,
  env: Env,
  process: QueueMessageProcessor<T>,
): Promise<void> {
  for (const message of batch.messages) {
    const startedAt = Date.now();
    try {
      const disposition = await process(message.body, env, {
        queue: batch.queue,
        messageId: message.id,
        attempt: message.attempts,
        enqueuedAt: message.timestamp,
        startedAt,
      });
      console.info({
        event: 'queue_message_processed',
        queue: batch.queue,
        queueMessageId: message.id,
        attempt: message.attempts,
        action: disposition.action,
        delaySeconds:
          disposition.action === 'retry' ? disposition.delaySeconds : undefined,
        queueAgeMs: Math.max(0, startedAt - message.timestamp.getTime()),
        durationMs: Date.now() - startedAt,
      });
      if (disposition.action === 'ack') {
        message.ack();
      } else {
        message.retry(
          disposition.delaySeconds === undefined
            ? undefined
            : { delaySeconds: disposition.delaySeconds },
        );
      }
    } catch (error) {
      console.error({
        event: 'queue_message_failed',
        queue: batch.queue,
        queueMessageId: message.id,
        attempt: message.attempts,
        error: toLoggableError(error),
      });
      message.retry();
    }
  }
}
