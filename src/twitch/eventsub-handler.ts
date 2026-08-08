const MESSAGE_ID_HEADER = 'twitch-eventsub-message-id';
const MESSAGE_TYPE_HEADER = 'twitch-eventsub-message-type';
const MESSAGE_TIMESTAMP_HEADER = 'twitch-eventsub-message-timestamp';
const MESSAGE_SIGNATURE_HEADER = 'twitch-eventsub-message-signature';
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const DEDUPE_TTL_SECONDS = 10 * 60;

const inFlightMessageIds = new Set<string>();

interface EventSubEnvelope {
  challenge?: string;
  subscription: {
    id: string;
    type: string;
    condition: { broadcaster_user_id?: string };
  };
}

/** Verifies, deduplicates, and routes a Twitch EventSub webhook. */
export async function handleTwitchEventSub(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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
  if (
    !(await verifySignature(
      env.TWITCH_EVENTSUB_SECRET,
      messageId,
      timestamp,
      body,
      signature,
    ))
  ) {
    return new Response('Invalid EventSub signature', { status: 403 });
  }

  if (
    inFlightMessageIds.has(messageId) ||
    (await env.TWITCH_EVENT_IDS.get(messageId)) !== null
  ) {
    return new Response(null, { status: 204 });
  }
  inFlightMessageIds.add(messageId);
  try {
    const envelope = JSON.parse(body) as EventSubEnvelope;
    const broadcasterId = envelope.subscription.condition.broadcaster_user_id;
    const routeBroadcasterId = request.url.split('/').filter(Boolean).at(-1);
    if (broadcasterId === undefined || broadcasterId !== routeBroadcasterId) {
      return new Response('EventSub broadcaster mismatch', { status: 400 });
    }
    await env.TWITCH_EVENT_IDS.put(messageId, '1', {
      expirationTtl: DEDUPE_TTL_SECONDS,
    });
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId);

    if (messageType === 'webhook_callback_verification') {
      return envelope.challenge === undefined
        ? new Response('Missing EventSub challenge', { status: 400 })
        : new Response(envelope.challenge, {
            headers: { 'content-type': 'text/plain' },
          });
    }
    if (messageType === 'notification') {
      ctx.waitUntil(subscription.reconcile());
      return new Response(null, { status: 204 });
    }
    if (messageType === 'revocation') {
      ctx.waitUntil(subscription.revokeEventSub(envelope.subscription.id));
      return new Response(null, { status: 204 });
    }
    return new Response('Unsupported EventSub message type', { status: 400 });
  } finally {
    inFlightMessageIds.delete(messageId);
  }
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
