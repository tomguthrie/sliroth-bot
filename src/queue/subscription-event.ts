import { toLoggableError } from '../log';
import type {
  EventSubNotification,
  EventSubRevocation,
} from '../twitch/eventsub';
import type { YouTubeVideoNotification } from '../youtube';

export const SUBSCRIPTION_EVENTS_QUEUE = 'subscription-events';

export interface TwitchEventSubDelivery {
  kind: 'twitch-eventsub';
  messageId: string;
  timestamp: string;
  message: EventSubNotification | EventSubRevocation;
}

export interface TwitchVodLookupDelivery {
  kind: 'twitch-vod-lookup';
  broadcasterId: string;
  streamId: string;
}

export interface YouTubeVideoDelivery {
  kind: 'youtube-video';
  channelId: string;
  notification: YouTubeVideoNotification;
}

export type SubscriptionEventDelivery =
  TwitchEventSubDelivery | TwitchVodLookupDelivery | YouTubeVideoDelivery;

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
        await env.YOUTUBE_SUBSCRIPTIONS.getByName(
          delivery.channelId,
        ).recordVideo(delivery.notification);
      } else if (delivery.kind === 'twitch-vod-lookup') {
        const result = await env.TWITCH_SUBSCRIPTIONS.getByName(
          delivery.broadcasterId,
        ).enrichStreamVod(delivery.streamId);
        if (result === 'not-found') {
          const delaySeconds = [60, 120, 240, 480][queuedMessage.attempts - 1];
          if (delaySeconds !== undefined) {
            console.info({
              event: 'twitch_vod_lookup_deferred',
              queueMessageId: queuedMessage.id,
              streamId: delivery.streamId,
              attempt: queuedMessage.attempts,
              delaySeconds,
            });
            queuedMessage.retry({ delaySeconds });
            continue;
          }
          console.warn({
            event: 'twitch_vod_lookup_exhausted',
            queueMessageId: queuedMessage.id,
            streamId: delivery.streamId,
            attempt: queuedMessage.attempts,
          });
        }
      } else {
        await env.TWITCH_SUBSCRIPTIONS.getByName(
          delivery.message.subscription.broadcasterId,
        ).processEventSubMessage(delivery);
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
