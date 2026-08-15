import type { EventSubNotification, EventSubRevocation } from '../eventsub';

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

export interface TwitchSubscriptionEventContext {
  queueMessageId: string;
  attempt: number;
}

export type TwitchSubscriptionEventResult =
  { retry: false } | { retry: true; delaySeconds: number };

/** Processes a Twitch subscription event and applies provider retry policy. */
export async function processTwitchSubscriptionEvent(
  delivery: TwitchSubscriptionEventDelivery,
  env: Env,
  context: TwitchSubscriptionEventContext,
): Promise<TwitchSubscriptionEventResult> {
  if (delivery.kind === 'twitch-eventsub') {
    await env.TWITCH_SUBSCRIPTIONS.getByName(
      delivery.message.subscription.broadcasterId,
    ).processEventSubMessage(delivery);
    return { retry: false };
  }

  const result = await env.TWITCH_SUBSCRIPTIONS.getByName(
    delivery.broadcasterId,
  ).enrichStreamVod(delivery.streamId);
  if (result !== 'not-found') return { retry: false };

  const delaySeconds = [60, 120, 240, 480][context.attempt - 1];
  if (delaySeconds !== undefined) {
    console.info({
      event: 'twitch_vod_lookup_deferred',
      queueMessageId: context.queueMessageId,
      streamId: delivery.streamId,
      attempt: context.attempt,
      delaySeconds,
    });
    return { retry: true, delaySeconds };
  }

  console.warn({
    event: 'twitch_vod_lookup_exhausted',
    queueMessageId: context.queueMessageId,
    streamId: delivery.streamId,
    attempt: context.attempt,
  });
  return { retry: false };
}
