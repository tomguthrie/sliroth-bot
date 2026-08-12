import * as z from 'zod';

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
    type: 'channel.update' as const,
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
    started_at: z.iso.datetime().transform((value) => new Date(value)),
  })
  .transform((data) => ({
    type: 'stream.online' as const,
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
    type: 'stream.offline' as const,
    streamId: data.id,
    broadcasterId: data.broadcaster_user_id,
    broadcasterLogin: data.broadcaster_user_login,
    broadcasterName: data.broadcaster_user_name,
  }));

export type StreamOfflineEvent = z.output<typeof StreamOfflineEvent>;

export type TwitchEvent =
  ChannelUpdateEvent | StreamOnlineEvent | StreamOfflineEvent;

const EventSubEnvelope = z.object({
  subscription: z.object({
    id: z.string(),
    type: z.string(),
    version: z.string(),
  }),
  event: z.unknown(),
});

export function parseEventSubNotification(body: unknown): TwitchEvent {
  const envelope = EventSubEnvelope.parse(body);

  switch (envelope.subscription.type) {
    case 'channel.update':
      return ChannelUpdateEvent.parse(envelope.event);

    case 'stream.online':
      return StreamOnlineEvent.parse(envelope.event);

    case 'stream.offline':
      return StreamOfflineEvent.parse(envelope.event);

    default:
      throw new Error(
        `Unsupported Twitch EventSub type: ${envelope.subscription.type}`,
      );
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

  let difference = 0;

  for (let index = 0; index < actual.length; index++) {
    difference |= actual[index]! ^ expectedBytes[index]!;
  }

  return difference === 0;
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

const EventSubChallenge = z.object({
  challenge: z.string(),
});

export function parseEventSubChallenge(body: unknown): string {
  return EventSubChallenge.parse(body).challenge;
}

const EventSubRevocation = z.object({
  subscription: z.object({
    id: z.string(),
    type: z.string(),
    version: z.string(),
    status: z.string(),
  }),
});

export type EventSubRevocation = z.output<typeof EventSubRevocation>;

export function parseEventSubRevocation(body: unknown): EventSubRevocation {
  return EventSubRevocation.parse(body);
}
