import * as z from 'zod';

import { toLoggableError } from '../log';
import {
  TwitchBroadcasterId,
  TwitchEventSubSubscriptionId,
  TwitchStreamId,
  TwitchTimestamp,
} from '../twitch/data';
import {
  TwitchChannelUpdateEvent,
  TwitchStreamOfflineEvent,
  TwitchStreamOnlineEvent,
} from '../twitch/event-sub/events';
import { YouTubeChannelId } from '../youtube/data';
import { YouTubeVideoNotification } from '../youtube/notification';

export const SUBSCRIPTION_EVENTS_QUEUE = 'subscription-events';

export const EventSubMessageId = z.string().min(1).brand<'EventSubMessageId'>();
export type EventSubMessageId = z.infer<typeof EventSubMessageId>;

const TwitchEventSubDeliveryBase = z.object({
  messageId: EventSubMessageId,
  broadcasterId: TwitchBroadcasterId,
  subscriptionId: TwitchEventSubSubscriptionId,
});

export const TwitchEventSubDelivery = z.discriminatedUnion('kind', [
  TwitchEventSubDeliveryBase.extend({
    kind: z.literal('twitch-channel-update'),
    event: TwitchChannelUpdateEvent,
  }),
  TwitchEventSubDeliveryBase.extend({
    kind: z.literal('twitch-stream-online'),
    event: TwitchStreamOnlineEvent,
  }),
  TwitchEventSubDeliveryBase.extend({
    kind: z.literal('twitch-stream-offline'),
    event: TwitchStreamOfflineEvent,
    timestamp: TwitchTimestamp,
  }),
  TwitchEventSubDeliveryBase.extend({
    kind: z.literal('twitch-revocation'),
  }),
]);

export type TwitchEventSubDelivery = z.infer<typeof TwitchEventSubDelivery>;

export const TwitchVodLookupDelivery = z.object({
  kind: z.literal('twitch-vod-lookup'),
  broadcasterId: TwitchBroadcasterId,
  streamId: TwitchStreamId,
});

export type TwitchVodLookupDelivery = z.infer<typeof TwitchVodLookupDelivery>;

export const YouTubeVideoDelivery = z.object({
  kind: z.literal('youtube-video'),
  channelId: YouTubeChannelId,
  notification: YouTubeVideoNotification,
});

export type YouTubeVideoDelivery = z.infer<typeof YouTubeVideoDelivery>;

export const SubscriptionEventDelivery = z.discriminatedUnion('kind', [
  ...TwitchEventSubDelivery.options,
  TwitchVodLookupDelivery,
  YouTubeVideoDelivery,
]);

export type SubscriptionEventDelivery = z.infer<
  typeof SubscriptionEventDelivery
>;

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
          delivery.broadcasterId,
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
