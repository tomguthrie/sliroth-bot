import * as z from 'zod';

const MESSAGE_ID_HEADER = 'twitch-eventsub-message-id';
const MESSAGE_TYPE_HEADER = 'twitch-eventsub-message-type';
const MESSAGE_TIMESTAMP_HEADER = 'twitch-eventsub-message-timestamp';
const MESSAGE_SIGNATURE_HEADER = 'twitch-eventsub-message-signature';
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const DEDUPE_TTL_SECONDS = 10 * 60;

export const TWITCH_EVENT_STREAM_ONLINE = 'stream.online';
export const TWITCH_EVENT_STREAM_OFFLINE = 'stream.offline';

const inFlightMessageIds = new Set<string>();

const EventSubEnvelope = z.object({
  challenge: z.string().optional(),
  subscription: z.object({
    id: z.string(),
    type: z.string(),
    condition: z.object({
      broadcaster_user_id: z.string().optional(),
    }),
  }),
  event: z.unknown().optional(),
});

type EventSubEnvelope = z.infer<typeof EventSubEnvelope>;

interface AuthenticatedEventSubMessage {
  broadcasterId: string;
  envelope: EventSubEnvelope;
  messageId: string;
  messageType: string;
  timestamp: string;
}

export const TwitchStreamOnlineEvent = z.object({
  id: z.string(),
  broadcaster_user_id: z.string(),
  broadcaster_user_login: z.string(),
  broadcaster_user_name: z.string(),
  type: z.string(),
  started_at: z.string(),
});

export type TwitchStreamOnlineEvent = z.infer<typeof TwitchStreamOnlineEvent>;

export const TwitchStreamOfflineEvent = z.object({
  id: z.string(),
  broadcaster_user_id: z.string(),
  broadcaster_user_login: z.string(),
  broadcaster_user_name: z.string(),
});

export type TwitchStreamOfflineEvent = z.infer<typeof TwitchStreamOfflineEvent>;

/** Verifies, deduplicates, and routes a Twitch EventSub webhook. */
export async function handleTwitchEventSub(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const message = await authenticateEventSubMessage(
    request,
    env.TWITCH_EVENTSUB_SECRET,
  );
  if (message instanceof Response) {
    return message;
  }

  if (message.messageType === 'webhook_callback_verification') {
    return message.envelope.challenge === undefined
      ? new Response('Missing EventSub challenge', { status: 400 })
      : new Response(message.envelope.challenge, {
          headers: { 'content-type': 'text/plain' },
        });
  }
  return processEventSubDelivery(message, env);
}

async function authenticateEventSubMessage(
  request: Request,
  secret: string,
): Promise<AuthenticatedEventSubMessage | Response> {
  const messageId = request.headers.get(MESSAGE_ID_HEADER);
  const messageType = request.headers.get(MESSAGE_TYPE_HEADER);
  const timestamp = request.headers.get(MESSAGE_TIMESTAMP_HEADER);
  const signature = request.headers.get(MESSAGE_SIGNATURE_HEADER);
  if (
    messageId === null ||
    messageType === null ||
    timestamp === null ||
    signature === null
  ) {
    return new Response('Missing EventSub headers', { status: 400 });
  }

  const sentAt = Date.parse(timestamp);
  const age = Date.now() - sentAt;
  if (
    Number.isNaN(sentAt) ||
    age > MAX_MESSAGE_AGE_MS ||
    age < -MAX_FUTURE_SKEW_MS
  ) {
    return new Response('Stale EventSub message', { status: 403 });
  }

  const body = await request.text();
  if (!(await verifySignature(secret, messageId, timestamp, body, signature))) {
    return new Response('Invalid EventSub signature', { status: 403 });
  }

  const envelope = parseEventSubEnvelope(body);
  if (envelope === undefined) {
    return new Response('Invalid EventSub payload', { status: 400 });
  }
  const broadcasterId = envelope.subscription.condition.broadcaster_user_id;
  const routeBroadcasterId = request.url.split('/').filter(Boolean).at(-1);
  if (broadcasterId === undefined || broadcasterId !== routeBroadcasterId) {
    return new Response('EventSub broadcaster mismatch', { status: 400 });
  }

  return { broadcasterId, envelope, messageId, messageType, timestamp };
}

function parseEventSubEnvelope(body: string): EventSubEnvelope | undefined {
  try {
    const result = EventSubEnvelope.safeParse(JSON.parse(body));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function processEventSubDelivery(
  message: AuthenticatedEventSubMessage,
  env: Env,
): Promise<Response> {
  const { broadcasterId, envelope, messageId, messageType, timestamp } =
    message;
  if (messageType !== 'notification' && messageType !== 'revocation') {
    return new Response('Unsupported EventSub message type', { status: 400 });
  }
  if (
    inFlightMessageIds.has(messageId) ||
    (await env.TWITCH_EVENT_IDS.get(messageId)) !== null
  ) {
    return new Response(null, { status: 204 });
  }

  inFlightMessageIds.add(messageId);
  try {
    if (messageType === 'notification') {
      const error = await processEventSubNotification(
        env,
        broadcasterId,
        envelope,
        timestamp,
      );
      if (error !== undefined) {
        return error;
      }
    } else {
      await env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId).revokeEventSub(
        envelope.subscription.id,
      );
    }
    await env.TWITCH_EVENT_IDS.put(messageId, '1', {
      expirationTtl: DEDUPE_TTL_SECONDS,
    });
    return new Response(null, { status: 204 });
  } finally {
    inFlightMessageIds.delete(messageId);
  }
}

async function processEventSubNotification(
  env: Env,
  broadcasterId: string,
  envelope: EventSubEnvelope,
  timestamp: string,
): Promise<Response | undefined> {
  if (envelope.event === undefined) {
    return new Response('Missing EventSub event', { status: 400 });
  }
  const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId);
  if (envelope.subscription.type === TWITCH_EVENT_STREAM_ONLINE) {
    const result = TwitchStreamOnlineEvent.safeParse(envelope.event);
    if (!result.success) {
      return new Response('Invalid stream.online event', { status: 400 });
    }
    await subscription.streamOnline(result.data);
  } else if (envelope.subscription.type === TWITCH_EVENT_STREAM_OFFLINE) {
    const result = TwitchStreamOfflineEvent.safeParse(envelope.event);
    if (!result.success) {
      return new Response('Invalid stream.offline event', { status: 400 });
    }
    await subscription.streamOffline(result.data, timestamp);
  } else {
    return new Response('Unsupported EventSub subscription type', {
      status: 400,
    });
  }

  await subscription.reconcile();
  return undefined;
}

async function verifySignature(
  secret: string,
  messageId: string,
  timestamp: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(messageId + timestamp + body),
    ),
  );
  const received = parseSignature(signature);
  return (
    received !== undefined && crypto.subtle.timingSafeEqual(expected, received)
  );
}

function parseSignature(value: string): Uint8Array | undefined {
  if (!/^sha256=[0-9a-f]{64}$/i.test(value)) return undefined;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      value.slice(7 + index * 2, 9 + index * 2),
      16,
    );
  }
  return bytes;
}
