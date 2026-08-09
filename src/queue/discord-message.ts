import {
  DiscordApiError,
  editDiscordMessage,
  sendDiscordMessage,
} from '../discord/client';
import type { DiscordMessage } from '../discord/message';
import { DiscordRequestValidationError } from '../discord/request';

const MAX_QUEUE_RETRY_DELAY_SECONDS = 24 * 60 * 60;

interface DiscordMessageDeliveryBase {
  guildId: string;
  channelId: string;
  message: DiscordMessage;
}

export interface DiscordCreateMessageDelivery extends DiscordMessageDeliveryBase {
  operation: 'create';
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
  if (deliveries.length === 0) {
    return;
  }

  await queue.sendBatch(deliveries.map((body) => ({ body })));
}

/** Delivers a Queue batch to Discord with per-message retry decisions. */
export async function deliverDiscordMessageBatch(
  batch: MessageBatch<DiscordMessageDelivery>,
  env: Env,
): Promise<void> {
  for (const queuedMessage of batch.messages) {
    try {
      const options = {
        botToken: env.DISCORD_BOT_TOKEN,
        applicationUrl: env.PUBLIC_BASE_URL,
        channelId: queuedMessage.body.channelId,
        message: queuedMessage.body.message,
      };
      if (queuedMessage.body.operation === 'create') {
        await sendDiscordMessage(options);
      } else {
        await editDiscordMessage({
          ...options,
          messageId: queuedMessage.body.messageId,
        });
      }
      queuedMessage.ack();
    } catch (error) {
      if (error instanceof DiscordRequestValidationError) {
        logDeliveryFailure(queuedMessage, error, false);
        queuedMessage.ack();
        continue;
      }

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
  console.error(
    JSON.stringify({
      event: 'discord_message_delivery_failed',
      queueMessageId: queuedMessage.id,
      guildId: queuedMessage.body.guildId,
      channelId: queuedMessage.body.channelId,
      retry,
      status: error instanceof DiscordApiError ? error.status : undefined,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
