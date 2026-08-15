import {
  createDiscordMessageProcessor,
  type DiscordMessageDelivery,
} from '../discord/queue';
import {
  processTwitchSubscriptionEvent,
  type TwitchSubscriptionEventDelivery,
} from '../twitch/subscription/queue';
import { twitchStreamMessageReceiptHandler } from '../twitch/subscription/message-receipt';
import {
  processYouTubeSubscriptionEvent,
  type YouTubeVideoDelivery,
} from '../youtube/subscription/queue';
import { deliverQueueMessages, type QueueMessageProcessor } from './message';

const DISCORD_MESSAGES_QUEUE = 'discord-messages';
const SUBSCRIPTION_EVENTS_QUEUE = 'subscription-events';

type SubscriptionEventDelivery =
  TwitchSubscriptionEventDelivery | YouTubeVideoDelivery;

export type WorkerQueueMessage =
  DiscordMessageDelivery | SubscriptionEventDelivery;

const processDiscordMessage = createDiscordMessageProcessor([
  twitchStreamMessageReceiptHandler,
]);

const processSubscriptionEvent: QueueMessageProcessor<
  SubscriptionEventDelivery
> = async (delivery, env, context) => {
  switch (delivery.kind) {
    case 'twitch-eventsub':
    case 'twitch-vod-lookup':
      return processTwitchSubscriptionEvent(delivery, env, context);
    case 'youtube-video':
      return processYouTubeSubscriptionEvent(delivery, env, context);
  }
};

/** Routes Queue batches to the consumer matching the configured queue name. */
export async function deliverQueueBatch(
  batch: MessageBatch<WorkerQueueMessage>,
  env: Env,
): Promise<void> {
  if (batch.queue === DISCORD_MESSAGES_QUEUE) {
    await deliverQueueMessages(batch, env, processDiscordQueueMessage);
    return;
  }
  if (batch.queue === SUBSCRIPTION_EVENTS_QUEUE) {
    await deliverQueueMessages(batch, env, processSubscriptionQueueMessage);
    return;
  }

  console.error({ event: 'queue_unknown', queue: batch.queue });
  batch.retryAll();
}

const processDiscordQueueMessage: QueueMessageProcessor<
  WorkerQueueMessage
> = async (delivery, env, context) => {
  if ('operation' in delivery) {
    return processDiscordMessage(delivery, env, context);
  }
  throw new Error('Unsupported message in the Discord messages queue');
};

const processSubscriptionQueueMessage: QueueMessageProcessor<
  WorkerQueueMessage
> = async (delivery, env, context) => {
  if ('kind' in delivery) {
    return processSubscriptionEvent(delivery, env, context);
  }
  throw new Error('Unsupported message in the subscription events queue');
};
