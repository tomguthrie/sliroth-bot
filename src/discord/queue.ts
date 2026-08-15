import {
  DiscordApiError,
  editDiscordMessage,
  sendDiscordMessage,
  type DiscordMessageReceipt,
} from './client';
import type { DiscordMessage } from './message';
import { toLoggableError } from '../log';
import type {
  QueueMessageContext,
  QueueMessageDisposition,
  QueueMessageProcessor,
} from '../queue/message';

const MAX_QUEUE_RETRY_DELAY_SECONDS = 24 * 60 * 60;

export interface DiscordMessageReceiptTarget {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface DiscordMessageReceiptHandler {
  readonly type: string;
  readonly handle: (
    target: DiscordMessageReceiptTarget,
    receipt: DiscordMessageReceipt,
    env: Env,
  ) => Promise<void>;
}

interface DiscordMessageDeliveryBase {
  guildId: string;
  channelId: string;
  message: DiscordMessage;
}

export interface DiscordCreateMessageDelivery extends DiscordMessageDeliveryBase {
  operation: 'create';
  receipt?: DiscordMessageReceiptTarget;
}

export interface DiscordEditMessageDelivery extends DiscordMessageDeliveryBase {
  operation: 'edit';
  messageId: string;
}

export type DiscordMessageDelivery =
  DiscordCreateMessageDelivery | DiscordEditMessageDelivery;

interface DiscordMessageQueue {
  sendBatch(
    messages: Iterable<MessageSendRequest<DiscordMessageDelivery>>,
  ): Promise<unknown>;
}

/** Sends Discord deliveries to Cloudflare Queues as a single batch. */
export async function enqueueDiscordMessages(
  queue: DiscordMessageQueue,
  deliveries: readonly DiscordMessageDelivery[],
): Promise<void> {
  if (deliveries.length === 0) return;
  await queue.sendBatch(deliveries.map((body) => ({ body })));
}

/** Creates a Discord message processor with feature-owned receipt handlers. */
export function createDiscordMessageProcessor(
  receiptHandlers: readonly DiscordMessageReceiptHandler[],
): QueueMessageProcessor<DiscordMessageDelivery> {
  const receiptsByType = new Map<string, DiscordMessageReceiptHandler>();
  for (const handler of receiptHandlers) {
    if (receiptsByType.has(handler.type)) {
      throw new Error(`Duplicate Discord message receipt: ${handler.type}`);
    }
    receiptsByType.set(handler.type, handler);
  }

  return async (delivery, env, context) => {
    try {
      const options = {
        botToken: env.DISCORD_BOT_TOKEN,
        applicationUrl: env.PUBLIC_BASE_URL,
        channelId: delivery.channelId,
        message: delivery.message,
      };
      const discordStartedAt = Date.now();
      let receiptDurationMs: number | undefined;
      if (delivery.operation === 'create') {
        const receipt = await sendDiscordMessage(options);
        const discordDurationMs = Date.now() - discordStartedAt;
        if (delivery.receipt !== undefined) {
          const handler = receiptsByType.get(delivery.receipt.type);
          if (handler === undefined) {
            throw new Error(
              `Unsupported Discord message receipt: ${delivery.receipt.type}`,
            );
          }
          const receiptStartedAt = Date.now();
          await handler.handle(delivery.receipt, receipt, env);
          receiptDurationMs = Date.now() - receiptStartedAt;
        }
        logDeliverySuccess(
          delivery,
          context,
          discordDurationMs,
          receiptDurationMs,
        );
      } else {
        await editDiscordMessage({
          ...options,
          messageId: delivery.messageId,
        });
        logDeliverySuccess(delivery, context, Date.now() - discordStartedAt);
      }
      return { action: 'ack' };
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        error.status !== 429 &&
        error.status < 500
      ) {
        logDeliveryFailure(delivery, context, error, false);
        return { action: 'ack' };
      }

      logDeliveryFailure(delivery, context, error, true);
      const delaySeconds = getRetryDelaySeconds(error);
      return createRetryDisposition(delaySeconds);
    }
  };
}

function logDeliverySuccess(
  delivery: DiscordMessageDelivery,
  context: QueueMessageContext,
  discordDurationMs: number,
  receiptDurationMs?: number,
): void {
  console.info({
    event: 'discord_message_delivered',
    queueMessageId: context.messageId,
    guildId: delivery.guildId,
    channelId: delivery.channelId,
    operation: delivery.operation,
    attempt: context.attempt,
    queueAgeMs: Math.max(0, context.startedAt - context.enqueuedAt.getTime()),
    discordDurationMs,
    receiptDurationMs,
    durationMs: Date.now() - context.startedAt,
  });
}

function getRetryDelaySeconds(error: unknown): number | undefined {
  if (
    !(error instanceof DiscordApiError) ||
    error.status !== 429 ||
    error.retryAfterSeconds === undefined
  ) {
    return undefined;
  }
  return Math.min(
    MAX_QUEUE_RETRY_DELAY_SECONDS,
    Math.max(1, Math.ceil(error.retryAfterSeconds)),
  );
}

function logDeliveryFailure(
  delivery: DiscordMessageDelivery,
  context: QueueMessageContext,
  error: unknown,
  retry: boolean,
): void {
  console.error({
    event: 'discord_message_delivery_failed',
    queueMessageId: context.messageId,
    guildId: delivery.guildId,
    channelId: delivery.channelId,
    retry,
    status: error instanceof DiscordApiError ? error.status : undefined,
    error: toLoggableError(error),
  });
}

function createRetryDisposition(
  delaySeconds: number | undefined,
): QueueMessageDisposition {
  return delaySeconds === undefined
    ? { action: 'retry' }
    : { action: 'retry', delaySeconds };
}
