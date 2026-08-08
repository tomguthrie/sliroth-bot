import type { IRequest } from 'itty-router';

const WEBSUB_CHALLENGE = /^[+\-0-9=A-Z_a-z]+$/;
const MAX_WEBSUB_CHALLENGE_LENGTH = 2048;

/** Confirms or rejects a YouTube WebSub subscription intent. */
export async function handleYouTubeWebSubIntent(
  request: IRequest,
  env: Env,
): Promise<Response> {
  const channelId = request.params.channelId;
  if (channelId === undefined || channelId === '') {
    return new Response('Not Found', { status: 404 });
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const topic = url.searchParams.get('hub.topic');

  if (topic === null) {
    return new Response('Bad Request', { status: 400 });
  }

  const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(channelId);

  if (mode === 'denied') {
    const accepted = await subscription.denyWebSubIntent(
      topic,
      url.searchParams.get('hub.reason') ?? undefined,
    );

    return new Response(null, { status: accepted ? 204 : 404 });
  }

  if (mode !== 'subscribe' && mode !== 'unsubscribe') {
    return new Response('Bad Request', { status: 400 });
  }

  const challenge = url.searchParams.get('hub.challenge');
  if (!isValidChallenge(challenge)) {
    return new Response('Bad Request', { status: 400 });
  }

  const leaseSeconds =
    mode === 'subscribe'
      ? parseLeaseSeconds(url.searchParams.get('hub.lease_seconds'))
      : undefined;
  if (mode === 'subscribe' && leaseSeconds === undefined) {
    return new Response('Bad Request', { status: 400 });
  }

  const accepted = await subscription.confirmWebSubIntent(
    mode,
    topic,
    leaseSeconds,
  );
  if (!accepted) {
    return new Response('Not Found', { status: 404 });
  }

  return new Response(challenge, {
    headers: {
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Authenticates and records a YouTube WebSub notification. */
export async function handleYouTubeWebSubNotification(
  request: IRequest,
  env: Env,
): Promise<Response> {
  const channelId = request.params.channelId;
  if (channelId === undefined || channelId === '') {
    return new Response('Not Found', { status: 404 });
  }

  const accepted = await env.YOUTUBE_SUBSCRIPTIONS.getByName(
    channelId,
  ).receiveWebSubNotification(
    await request.arrayBuffer(),
    request.headers.get('x-hub-signature'),
  );

  return new Response(null, { status: accepted ? 204 : 401 });
}

function isValidChallenge(challenge: string | null): challenge is string {
  return (
    challenge !== null &&
    challenge.length <= MAX_WEBSUB_CHALLENGE_LENGTH &&
    WEBSUB_CHALLENGE.test(challenge)
  );
}

function parseLeaseSeconds(value: string | null): number | undefined {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) {
    return undefined;
  }

  const leaseSeconds = Number(value);
  return Number.isSafeInteger(leaseSeconds) ? leaseSeconds : undefined;
}
