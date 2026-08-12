import type { DiscordMessageDelivery } from './discord-message';
import { deliverDiscordMessageBatch } from './discord-message';
import type { SubscriptionEventDelivery } from './subscription-event';
import {
  deliverSubscriptionEventBatch,
  SUBSCRIPTION_EVENTS_QUEUE,
} from './subscription-event';

const DISCORD_MESSAGES_QUEUE = 'discord-messages';

export type WorkerQueueMessage =
  DiscordMessageDelivery | SubscriptionEventDelivery;

/** Routes Queue batches to the consumer matching the configured queue name. */
export async function deliverQueueBatch(
  batch: MessageBatch<WorkerQueueMessage>,
  env: Env,
): Promise<void> {
  if (batch.queue === DISCORD_MESSAGES_QUEUE) {
    await deliverDiscordMessageBatch(
      batch as MessageBatch<DiscordMessageDelivery>,
      env,
    );
    return;
  }
  if (batch.queue === SUBSCRIPTION_EVENTS_QUEUE) {
    await deliverSubscriptionEventBatch(
      batch as MessageBatch<SubscriptionEventDelivery>,
      env,
    );
    return;
  }

  console.error({ event: 'queue_unknown', queue: batch.queue });
  batch.retryAll();
}
