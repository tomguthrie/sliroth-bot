import { toLoggableError } from '../log';
import type { TwitchSubscriptionEventDelivery } from '../twitch/subscription/queue';
import { processTwitchSubscriptionEvent } from '../twitch/subscription/queue';
import type { YouTubeVideoDelivery } from '../youtube/subscription/queue';
import { processYouTubeSubscriptionEvent } from '../youtube/subscription/queue';

export const SUBSCRIPTION_EVENTS_QUEUE = 'subscription-events';

export type SubscriptionEventDelivery =
  TwitchSubscriptionEventDelivery | YouTubeVideoDelivery;

/** Processes durable subscription events with per-message retry decisions. */
export async function deliverSubscriptionEventBatch(
  batch: MessageBatch<SubscriptionEventDelivery>,
  env: Env,
): Promise<void> {
  for (const queuedMessage of batch.messages) {
    const delivery = queuedMessage.body;
    const startedAt = Date.now();
    try {
      if (delivery.kind === 'youtube-video') {
        await processYouTubeSubscriptionEvent(delivery, env);
      } else {
        const result = await processTwitchSubscriptionEvent(delivery, env, {
          queueMessageId: queuedMessage.id,
          attempt: queuedMessage.attempts,
        });
        if (result.retry) {
          queuedMessage.retry({ delaySeconds: result.delaySeconds });
          continue;
        }
      }
      console.info({
        event: 'subscription_event_processed',
        queueMessageId: queuedMessage.id,
        kind: delivery.kind,
        attempt: queuedMessage.attempts,
        queueAgeMs: Math.max(0, startedAt - queuedMessage.timestamp.getTime()),
        durationMs: Date.now() - startedAt,
      });
      queuedMessage.ack();
    } catch (error) {
      console.error({
        event: 'subscription_event_failed',
        queueMessageId: queuedMessage.id,
        kind: delivery.kind,
        attempt: queuedMessage.attempts,
        error: toLoggableError(error),
      });
      queuedMessage.retry();
    }
  }
}
