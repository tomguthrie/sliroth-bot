import * as z from 'zod';

export const TWITCH_EVENT_CHANNEL_UPDATE = 'channel.update';
export const TWITCH_EVENT_STREAM_ONLINE = 'stream.online';
export const TWITCH_EVENT_STREAM_OFFLINE = 'stream.offline';

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
    condition: z.object({
      broadcaster_user_id: z.string(),
    }),
  })
  .transform((data) => ({
    id: data.id,
    type: data.type,
    version: data.version,
    broadcasterId: data.condition.broadcaster_user_id,
  }));

export type EventSubSubscription = z.output<typeof EventSubSubscription>;

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
