import {
  DiscordApiError,
  editDiscordMessage,
  sendDiscordMessage,
  type DiscordMessage,
} from '../discord';
import { toLoggableError } from '../log';
import { recordTwitchStreamMessageReceipt } from '../twitch-subscription/message-receipt';

const MAX_QUEUE_RETRY_DELAY_SECONDS = 24 * 60 * 60;

export const DISCORD_RECEIPT_IGNORE = 'ignore';
export const DISCORD_RECEIPT_TWITCH_STREAM = 'twitch-stream';

export type DiscordMessageReceiptTarget =
  | { type: typeof DISCORD_RECEIPT_IGNORE }
  | {
      type: typeof DISCORD_RECEIPT_TWITCH_STREAM;
      broadcasterId: string;
      streamId: string;
    };

interface DiscordMessageDeliveryBase {
  guildId: string;
  channelId: string;
  message: DiscordMessage;
}

export interface DiscordCreateMessageDelivery extends DiscordMessageDeliveryBase {
  operation: 'create';
  receiptTarget: DiscordMessageReceiptTarget;
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

/** Delivers a Queue batch to Discord with per-message retry decisions. */
export async function deliverDiscordMessageBatch(
  batch: MessageBatch<DiscordMessageDelivery>,
  env: Env,
): Promise<void> {
  for (const queuedMessage of batch.messages) {
    const startedAt = Date.now();
    try {
      const body = queuedMessage.body;
      const options = {
        botToken: env.DISCORD_BOT_TOKEN,
        applicationUrl: env.PUBLIC_BASE_URL,
        channelId: body.channelId,
        message: body.message,
      };
      const discordStartedAt = Date.now();
      let receiptDurationMs: number | undefined;
      if (body.operation === 'create') {
        const receipt = await sendDiscordMessage(options);
        const discordDurationMs = Date.now() - discordStartedAt;
        switch (body.receiptTarget.type) {
          case DISCORD_RECEIPT_IGNORE:
            break;
          case DISCORD_RECEIPT_TWITCH_STREAM: {
            const receiptStartedAt = Date.now();
            await recordTwitchStreamMessageReceipt(
              body.receiptTarget.broadcasterId,
              body.receiptTarget.streamId,
              receipt,
              env,
            );
            receiptDurationMs = Date.now() - receiptStartedAt;
            break;
          }
        }
        logDeliverySuccess(
          queuedMessage,
          startedAt,
          discordDurationMs,
          receiptDurationMs,
        );
      } else {
        await editDiscordMessage({ ...options, messageId: body.messageId });
        logDeliverySuccess(
          queuedMessage,
          startedAt,
          Date.now() - discordStartedAt,
        );
      }
      queuedMessage.ack();
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        error.status !== 429 &&
        error.status < 500
      ) {
        logDeliveryFailure(queuedMessage, error, false);
        queuedMessage.ack();
        continue;
      }

      logDeliveryFailure(queuedMessage, error, true);
      const delaySeconds = getRetryDelaySeconds(error);
      queuedMessage.retry(
        delaySeconds === undefined ? undefined : { delaySeconds },
      );
    }
  }
}

function logDeliverySuccess(
  queuedMessage: Message<DiscordMessageDelivery>,
  startedAt: number,
  discordDurationMs: number,
  receiptDurationMs?: number,
): void {
  console.info({
    event: 'discord_message_delivered',
    queueMessageId: queuedMessage.id,
    guildId: queuedMessage.body.guildId,
    channelId: queuedMessage.body.channelId,
    operation: queuedMessage.body.operation,
    attempt: queuedMessage.attempts,
    queueAgeMs: Math.max(0, startedAt - queuedMessage.timestamp.getTime()),
    discordDurationMs,
    receiptDurationMs,
    durationMs: Date.now() - startedAt,
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
  queuedMessage: Message<DiscordMessageDelivery>,
  error: unknown,
  retry: boolean,
): void {
  console.error({
    event: 'discord_message_delivery_failed',
    queueMessageId: queuedMessage.id,
    guildId: queuedMessage.body.guildId,
    channelId: queuedMessage.body.channelId,
    retry,
    status: error instanceof DiscordApiError ? error.status : undefined,
    error: toLoggableError(error),
  });
}
