import type { EventSubNotification, EventSubRevocation } from '../eventsub';
import type {
  QueueMessageDisposition,
  QueueMessageProcessor,
} from '../../queue/message';
import { TwitchApiClient } from '../client';

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

export type TwitchSubscriptionEventDelivery =
  TwitchEventSubDelivery | TwitchVodLookupDelivery;

/** Processes a Twitch subscription event and applies provider retry policy. */
export const processTwitchSubscriptionEvent: QueueMessageProcessor<
  TwitchSubscriptionEventDelivery
> = async (delivery, env, context): Promise<QueueMessageDisposition> => {
  if (delivery.kind === 'twitch-eventsub') {
    await env.TWITCH_SUBSCRIPTIONS.getByName(
      delivery.message.subscription.broadcasterId,
    ).processEventSubMessage(delivery);
    return { action: 'ack' };
  }

  const vods = await new TwitchApiClient(env).getVideos(delivery.broadcasterId);
  const vod = vods.find(
    (candidate) => candidate.streamId === delivery.streamId,
  );
  if (vod !== undefined) {
    await env.TWITCH_SUBSCRIPTIONS.getByName(
      delivery.broadcasterId,
    ).recordStreamVod(delivery.streamId, vod.url);
    return { action: 'ack' };
  }

  const delaySeconds = [60, 120, 240, 480][context.attempt - 1];
  if (delaySeconds !== undefined) {
    console.info({
      event: 'twitch_vod_lookup_deferred',
      queueMessageId: context.messageId,
      streamId: delivery.streamId,
      attempt: context.attempt,
      delaySeconds,
    });
    return { action: 'retry', delaySeconds };
  }

  console.warn({
    event: 'twitch_vod_lookup_exhausted',
    queueMessageId: context.messageId,
    streamId: delivery.streamId,
    attempt: context.attempt,
  });
  return { action: 'ack' };
};
