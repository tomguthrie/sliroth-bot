import * as z from 'zod';

import { toLoggableError } from '../log';
import {
  type ChannelUpdateEvent,
  type EventSubMessage,
  type StreamOfflineEvent,
  type StreamOnlineEvent,
  TWITCH_EVENT_CHANNEL_UPDATE,
  TWITCH_EVENT_STREAM_OFFLINE,
  TWITCH_EVENT_STREAM_ONLINE,
} from '../twitch/eventsub';
import { YouTubeChannelId } from '../youtube/data';
import { YouTubeVideoNotification } from '../youtube/notification';

export const SUBSCRIPTION_EVENTS_QUEUE = 'subscription-events';

interface TwitchEventSubDeliveryBase {
  messageId: string;
  broadcasterId: string;
  subscriptionId: string;
}

type StreamOnlineQueueEvent = Omit<StreamOnlineEvent, 'startedAt'> & {
  startedAt: string;
};

export type TwitchEventSubDelivery =
  | (TwitchEventSubDeliveryBase & {
      kind: 'twitch-channel-update';
      event: ChannelUpdateEvent;
    })
  | (TwitchEventSubDeliveryBase & {
      kind: 'twitch-stream-online';
      event: StreamOnlineQueueEvent;
    })
  | (TwitchEventSubDeliveryBase & {
      kind: 'twitch-stream-offline';
      event: StreamOfflineEvent;
      timestamp: string;
    })
  | (TwitchEventSubDeliveryBase & {
      kind: 'twitch-revocation';
    });

export interface TwitchVodLookupDelivery {
  kind: 'twitch-vod-lookup';
  broadcasterId: string;
  streamId: string;
}

/** Converts a parsed Twitch message into the Queue's JSON-safe wire shape. */
export function createTwitchEventSubDelivery(
  messageId: string,
  message: EventSubMessage,
  timestamp: Date,
): TwitchEventSubDelivery {
  const base = {
    messageId,
    broadcasterId: message.subscription.broadcasterId,
    subscriptionId: message.subscription.id,
  };

  if (message.messageType === 'revocation') {
    return { ...base, kind: 'twitch-revocation' };
  }
  if (message.messageType === 'webhook_callback_verification') {
    throw new Error('EventSub challenges are not queue deliveries');
  }

  switch (message.eventType) {
    case TWITCH_EVENT_CHANNEL_UPDATE:
      return {
        ...base,
        kind: 'twitch-channel-update',
        event: message.event,
      };
    case TWITCH_EVENT_STREAM_ONLINE:
      return {
        ...base,
        kind: 'twitch-stream-online',
        event: {
          ...message.event,
          startedAt: message.event.startedAt.toISOString(),
        },
      };
    case TWITCH_EVENT_STREAM_OFFLINE:
      return {
        ...base,
        kind: 'twitch-stream-offline',
        event: message.event,
        timestamp: timestamp.toISOString(),
      };
  }
}

export const YouTubeVideoDelivery = z.object({
  kind: z.literal('youtube-video'),
  channelId: YouTubeChannelId,
  notification: YouTubeVideoNotification,
});

export type YouTubeVideoDelivery = z.infer<typeof YouTubeVideoDelivery>;

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
