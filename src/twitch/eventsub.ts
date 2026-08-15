import * as z from 'zod';

export const TWITCH_EVENT_CHANNEL_UPDATE = 'channel.update';
export const TWITCH_EVENT_STREAM_ONLINE = 'stream.online';
export const TWITCH_EVENT_STREAM_OFFLINE = 'stream.offline';
export const TWITCH_EVENT_CHANNEL_FOLLOW = 'channel.follow';
export const TWITCH_EVENT_CHANNEL_SUBSCRIBE = 'channel.subscribe';
export const TWITCH_EVENT_CHANNEL_SUBSCRIPTION_GIFT =
  'channel.subscription.gift';
export const TWITCH_EVENT_CHANNEL_CHEER = 'channel.cheer';
export const TWITCH_EVENT_CHANNEL_POINTS_REDEMPTION =
  'channel.channel_points_custom_reward_redemption.add';
export const TWITCH_EVENT_CHANNEL_RAID = 'channel.raid';
export const TWITCH_EVENT_CHANNEL_CHAT_MESSAGE = 'channel.chat.message';

/** EventSub subscriptions supported by this Twitch integration. */
export const TWITCH_EVENTSUB_SUBSCRIPTIONS = [
  { type: TWITCH_EVENT_CHANNEL_UPDATE, version: '2' },
  { type: TWITCH_EVENT_STREAM_ONLINE, version: '1' },
  { type: TWITCH_EVENT_STREAM_OFFLINE, version: '1' },
] as const;

export type EventSubSubscriptionDefinition =
  (typeof TWITCH_EVENTSUB_SUBSCRIPTIONS)[number];

const ChannelUpdateEvent = z
  .object({
    broadcaster_user_id: z.string(),
    broadcaster_user_login: z.string(),
    broadcaster_user_name: z.string(),
    title: z.string(),
    language: z.string(),
    category_id: z.string(),
    category_name: z.string(),
    content_classification_labels: z.array(z.string()),
  })
  .transform((data) => ({
    broadcasterId: data.broadcaster_user_id,
    broadcasterLogin: data.broadcaster_user_login,
    broadcasterName: data.broadcaster_user_name,
    title: data.title,
    language: data.language,
    gameId: data.category_id,
    gameName: data.category_name,
    contentClassificationLabels: data.content_classification_labels,
  }));

export type ChannelUpdateEvent = z.output<typeof ChannelUpdateEvent>;

const StreamOnlineEvent = z
  .object({
    id: z.string(),
    broadcaster_user_id: z.string(),
    broadcaster_user_login: z.string(),
    broadcaster_user_name: z.string(),
    type: z.string(),
    started_at: z.iso.datetime(),
  })
  .transform((data) => ({
    streamId: data.id,
    broadcasterId: data.broadcaster_user_id,
    broadcasterLogin: data.broadcaster_user_login,
    broadcasterName: data.broadcaster_user_name,
    startedAt: data.started_at,
  }));

export type StreamOnlineEvent = z.output<typeof StreamOnlineEvent>;

const StreamOfflineEvent = z
  .object({
    id: z.string(),
    broadcaster_user_id: z.string(),
    broadcaster_user_login: z.string(),
    broadcaster_user_name: z.string(),
  })
  .transform((data) => ({
    streamId: data.id,
    broadcasterId: data.broadcaster_user_id,
    broadcasterLogin: data.broadcaster_user_login,
    broadcasterName: data.broadcaster_user_name,
  }));

export type StreamOfflineEvent = z.output<typeof StreamOfflineEvent>;

const EventSubSubscription = z
  .object({
    id: z.string(),
    type: z.string(),
    version: z.string(),
    condition: z.record(z.string(), z.string()),
  })
  .transform((data, context) => {
    const broadcasterId =
      data.condition.broadcaster_user_id ??
      data.condition.to_broadcaster_user_id ??
      data.condition.from_broadcaster_user_id;
    if (broadcasterId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'EventSub condition does not identify a broadcaster',
      });
      return z.NEVER;
    }
    return {
      id: data.id,
      type: data.type,
      version: data.version,
      broadcasterId,
    };
  });

export type EventSubSubscription = z.output<typeof EventSubSubscription>;

const EventUser = {
  user_id: z.string(),
  user_login: z.string(),
  user_name: z.string(),
};

const ChannelFollowEvent = z
  .object({
    ...EventUser,
    followed_at: z.iso.datetime(),
  })
  .transform((data) => ({
    userId: data.user_id,
    userLogin: data.user_login,
    userName: data.user_name,
    followedAt: data.followed_at,
  }));

const ChannelSubscribeEvent = z
  .object({
    ...EventUser,
    tier: z.string(),
    is_gift: z.boolean(),
  })
  .transform((data) => ({
    userId: data.user_id,
    userLogin: data.user_login,
    userName: data.user_name,
    tier: data.tier,
    isGift: data.is_gift,
  }));

const ChannelSubscriptionGiftEvent = z
  .object({
    user_id: z.string().nullable(),
    user_login: z.string().nullable(),
    user_name: z.string().nullable(),
    total: z.int().nonnegative(),
    tier: z.string(),
    is_anonymous: z.boolean(),
  })
  .transform((data) => ({
    userId: data.user_id,
    userLogin: data.user_login,
    userName: data.user_name,
    total: data.total,
    tier: data.tier,
    isAnonymous: data.is_anonymous,
  }));

const ChannelCheerEvent = z
  .object({
    user_id: z.string().nullable(),
    user_login: z.string().nullable(),
    user_name: z.string().nullable(),
    is_anonymous: z.boolean(),
    bits: z.int().nonnegative(),
  })
  .transform((data) => ({
    userId: data.user_id,
    userLogin: data.user_login,
    userName: data.user_name,
    isAnonymous: data.is_anonymous,
    bits: data.bits,
  }));

const ChannelPointsRedemptionEvent = z
  .object({
    id: z.string(),
    ...EventUser,
    reward: z.object({
      id: z.string(),
      title: z.string(),
      cost: z.int().nonnegative(),
    }),
    redeemed_at: z.iso.datetime(),
  })
  .transform((data) => ({
    redemptionId: data.id,
    userId: data.user_id,
    userLogin: data.user_login,
    userName: data.user_name,
    rewardId: data.reward.id,
    rewardTitle: data.reward.title,
    cost: data.reward.cost,
    redeemedAt: data.redeemed_at,
  }));

const ChannelRaidEvent = z
  .object({
    from_broadcaster_user_id: z.string(),
    from_broadcaster_user_login: z.string(),
    from_broadcaster_user_name: z.string(),
    to_broadcaster_user_id: z.string(),
    to_broadcaster_user_login: z.string(),
    to_broadcaster_user_name: z.string(),
    viewers: z.int().nonnegative(),
  })
  .transform((data) => ({
    fromBroadcasterUserId: data.from_broadcaster_user_id,
    fromBroadcasterUserLogin: data.from_broadcaster_user_login,
    fromBroadcasterUserName: data.from_broadcaster_user_name,
    toBroadcasterUserId: data.to_broadcaster_user_id,
    toBroadcasterUserLogin: data.to_broadcaster_user_login,
    toBroadcasterUserName: data.to_broadcaster_user_name,
    viewers: data.viewers,
  }));

const ChannelChatMessageEvent = z
  .object({
    broadcaster_user_id: z.string(),
    chatter_user_id: z.string(),
    chatter_user_login: z.string(),
    chatter_user_name: z.string(),
    message_id: z.string(),
    message_type: z.string(),
    source_broadcaster_user_id: z.string().nullable().optional(),
  })
  .transform((data) => ({
    broadcasterId: data.broadcaster_user_id,
    chatterUserId: data.chatter_user_id,
    chatterUserLogin: data.chatter_user_login,
    chatterUserName: data.chatter_user_name,
    messageId: data.message_id,
    messageType: data.message_type,
    ...(data.source_broadcaster_user_id === undefined
      ? {}
      : { sourceBroadcasterUserId: data.source_broadcaster_user_id }),
  }));

export type EventSubNotification =
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_CHANNEL_UPDATE;
      subscription: EventSubSubscription;
      event: ChannelUpdateEvent;
    }
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_STREAM_ONLINE;
      subscription: EventSubSubscription;
      event: StreamOnlineEvent;
    }
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_STREAM_OFFLINE;
      subscription: EventSubSubscription;
      event: StreamOfflineEvent;
    }
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_CHANNEL_FOLLOW;
      subscription: EventSubSubscription;
      event: z.output<typeof ChannelFollowEvent>;
    }
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_CHANNEL_SUBSCRIBE;
      subscription: EventSubSubscription;
      event: z.output<typeof ChannelSubscribeEvent>;
    }
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_CHANNEL_SUBSCRIPTION_GIFT;
      subscription: EventSubSubscription;
      event: z.output<typeof ChannelSubscriptionGiftEvent>;
    }
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_CHANNEL_CHEER;
      subscription: EventSubSubscription;
      event: z.output<typeof ChannelCheerEvent>;
    }
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_CHANNEL_POINTS_REDEMPTION;
      subscription: EventSubSubscription;
      event: z.output<typeof ChannelPointsRedemptionEvent>;
    }
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_CHANNEL_RAID;
      subscription: EventSubSubscription;
      event: z.output<typeof ChannelRaidEvent>;
    }
  | {
      messageType: 'notification';
      eventType: typeof TWITCH_EVENT_CHANNEL_CHAT_MESSAGE;
      subscription: EventSubSubscription;
      event: z.output<typeof ChannelChatMessageEvent>;
    };

export interface EventSubVerification {
  messageType: 'webhook_callback_verification';
  subscription: EventSubSubscription;
  challenge: string;
}

export interface EventSubRevocation {
  messageType: 'revocation';
  subscription: EventSubSubscription & { status: string };
}

export type EventSubMessage =
  EventSubNotification | EventSubVerification | EventSubRevocation;

const EventSubNotificationMessage = z.object({
  subscription: EventSubSubscription,
  event: z.unknown(),
});

const EventSubVerificationMessage = z.object({
  subscription: EventSubSubscription,
  challenge: z.string(),
});

const EventSubRevocationMessage = z.object({
  subscription: EventSubSubscription.and(z.object({ status: z.string() })),
});

function parseEventSubNotification(body: unknown): EventSubNotification {
  const envelope = EventSubNotificationMessage.parse(body);
  switch (envelope.subscription.type) {
    case TWITCH_EVENT_CHANNEL_UPDATE:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_CHANNEL_UPDATE,
        subscription: envelope.subscription,
        event: ChannelUpdateEvent.parse(envelope.event),
      };

    case TWITCH_EVENT_STREAM_ONLINE:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_STREAM_ONLINE,
        subscription: envelope.subscription,
        event: StreamOnlineEvent.parse(envelope.event),
      };

    case TWITCH_EVENT_STREAM_OFFLINE:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_STREAM_OFFLINE,
        subscription: envelope.subscription,
        event: StreamOfflineEvent.parse(envelope.event),
      };

    case TWITCH_EVENT_CHANNEL_FOLLOW:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_CHANNEL_FOLLOW,
        subscription: envelope.subscription,
        event: ChannelFollowEvent.parse(envelope.event),
      };
    case TWITCH_EVENT_CHANNEL_SUBSCRIBE:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_CHANNEL_SUBSCRIBE,
        subscription: envelope.subscription,
        event: ChannelSubscribeEvent.parse(envelope.event),
      };
    case TWITCH_EVENT_CHANNEL_SUBSCRIPTION_GIFT:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_CHANNEL_SUBSCRIPTION_GIFT,
        subscription: envelope.subscription,
        event: ChannelSubscriptionGiftEvent.parse(envelope.event),
      };
    case TWITCH_EVENT_CHANNEL_CHEER:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_CHANNEL_CHEER,
        subscription: envelope.subscription,
        event: ChannelCheerEvent.parse(envelope.event),
      };
    case TWITCH_EVENT_CHANNEL_POINTS_REDEMPTION:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_CHANNEL_POINTS_REDEMPTION,
        subscription: envelope.subscription,
        event: ChannelPointsRedemptionEvent.parse(envelope.event),
      };
    case TWITCH_EVENT_CHANNEL_RAID:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_CHANNEL_RAID,
        subscription: envelope.subscription,
        event: ChannelRaidEvent.parse(envelope.event),
      };
    case TWITCH_EVENT_CHANNEL_CHAT_MESSAGE:
      return {
        messageType: 'notification',
        eventType: TWITCH_EVENT_CHANNEL_CHAT_MESSAGE,
        subscription: envelope.subscription,
        event: ChannelChatMessageEvent.parse(envelope.event),
      };

    default:
      throw new Error(
        `Unsupported Twitch EventSub type: ${envelope.subscription.type}`,
      );
  }
}

/**
 * Parses a Twitch EventSub body and returns normalized message data.
 *
 * This is the boundary between Twitch's wire format and application code. The
 * returned value contains camel-case fields and ISO timestamps.
 */
export function parseEventSubMessage(
  messageType: EventSubMessageType,
  body: unknown,
): EventSubMessage {
  switch (messageType) {
    case 'notification':
      return parseEventSubNotification(body);

    case 'webhook_callback_verification': {
      const envelope = EventSubVerificationMessage.parse(body);
      return {
        messageType,
        subscription: envelope.subscription,
        challenge: envelope.challenge,
      };
    }

    case 'revocation': {
      const envelope = EventSubRevocationMessage.parse(body);
      return {
        messageType,
        subscription: envelope.subscription,
      };
    }
  }
}

export async function verifyEventSubRequest(
  request: Request,
  body: string,
  secret: string,
): Promise<boolean> {
  const messageId = request.headers.get('Twitch-Eventsub-Message-Id');
  const timestamp = request.headers.get('Twitch-Eventsub-Message-Timestamp');
  const signature = request.headers.get('Twitch-Eventsub-Message-Signature');

  if (
    messageId === null ||
    timestamp === null ||
    !signature?.startsWith('sha256=')
  ) {
    return false;
  }

  const expected = signature.slice('sha256='.length);

  if (!/^[0-9a-fA-F]{64}$/.test(expected)) {
    return false;
  }

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );

  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${messageId}${timestamp}${body}`),
  );

  const actual = new Uint8Array(digest);
  const expectedBytes = Uint8Array.from(expected.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );

  if (actual.length !== expectedBytes.length) {
    return false;
  }

  return crypto.subtle.timingSafeEqual(actual, expectedBytes);
}

export type EventSubMessageType =
  'notification' | 'webhook_callback_verification' | 'revocation';

export function getEventSubMessageType(
  request: Request,
): EventSubMessageType | undefined {
  const type = request.headers.get('Twitch-Eventsub-Message-Type');

  switch (type) {
    case 'notification':
    case 'webhook_callback_verification':
    case 'revocation':
      return type;

    default:
      return undefined;
  }
}

export function getEventSubMessageId(request: Request): string | undefined {
  return request.headers.get('Twitch-Eventsub-Message-Id') ?? undefined;
}

export function getEventSubMessageTimestamp(
  request: Request,
): Date | undefined {
  const value = request.headers.get('Twitch-Eventsub-Message-Timestamp');

  if (value === null) {
    return undefined;
  }

  const timestamp = new Date(value);

  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
}
