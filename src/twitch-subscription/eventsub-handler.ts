import {
  getEventSubMessageId,
  getEventSubMessageTimestamp,
  getEventSubMessageType,
  parseEventSubMessage,
  verifyEventSubRequest,
} from '../twitch/eventsub';
import { createTwitchEventSubDelivery } from '../queue/subscription-event';

const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

/** Verifies and routes a Twitch EventSub webhook. */
export async function handleTwitchEventSub(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const messageId = getEventSubMessageId(request);
  const messageType = getEventSubMessageType(request);
  const timestamp = getEventSubMessageTimestamp(request);
  if (
    messageId === undefined ||
    messageType === undefined ||
    timestamp === undefined
  ) {
    return new Response('Missing EventSub headers', { status: 400 });
  }

  const age = Date.now() - timestamp.getTime();
  if (age > MAX_MESSAGE_AGE_MS || age < -MAX_FUTURE_SKEW_MS) {
    return new Response('Stale EventSub message', { status: 403 });
  }

  const body = await request.text();
  if (
    !(await verifyEventSubRequest(request, body, env.TWITCH_EVENTSUB_SECRET))
  ) {
    return new Response('Invalid EventSub signature', { status: 403 });
  }

  let message;
  try {
    message = parseEventSubMessage(messageType, JSON.parse(body));
  } catch {
    return new Response('Invalid EventSub payload', { status: 400 });
  }

  const routeBroadcasterId = new URL(request.url).pathname
    .split('/')
    .filter(Boolean)
    .at(-1);
  if (message.subscription.broadcasterId !== routeBroadcasterId) {
    return new Response('EventSub broadcaster mismatch', { status: 400 });
  }

  if (message.messageType === 'webhook_callback_verification') {
    return new Response(message.challenge, {
      headers: { 'content-type': 'text/plain' },
    });
  }

  await env.SUBSCRIPTION_EVENTS.send(
    createTwitchEventSubDelivery(messageId, message, timestamp),
  );
  return new Response(null, { status: 204 });
}
