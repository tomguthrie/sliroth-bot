import type { IRequest } from 'itty-router';
import * as z from 'zod';

import { YouTubeChannelId } from './data';
import { WebSubLeaseSeconds, WebSubMode } from './websub';

const MAX_WEBSUB_CHALLENGE_LENGTH = 2048;

export const WebSubChallenge = z
  .string()
  .max(MAX_WEBSUB_CHALLENGE_LENGTH)
  .regex(/^[+\-0-9=A-Z_a-z]+$/)
  .brand<'WebSubChallenge'>();

export type WebSubChallenge = z.infer<typeof WebSubChallenge>;

const WebSubLeaseQuery = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(WebSubLeaseSeconds);

/** Confirms or rejects a YouTube WebSub subscription intent. */
export async function handleYouTubeWebSubIntent(
  request: IRequest,
  env: Env,
): Promise<Response> {
  const channelId = YouTubeChannelId.safeParse(request.params.channelId);
  if (!channelId.success) {
    return new Response('Not Found', { status: 404 });
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const topic = url.searchParams.get('hub.topic');

  if (topic === null) {
    return new Response('Bad Request', { status: 400 });
  }

  const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(channelId.data);

  if (mode === 'denied') {
    const accepted = await subscription.denyWebSubIntent(
      topic,
      url.searchParams.get('hub.reason') ?? undefined,
    );

    return new Response(null, { status: accepted ? 204 : 404 });
  }

  const webSubMode = WebSubMode.safeParse(mode);
  if (!webSubMode.success) {
    return new Response('Bad Request', { status: 400 });
  }

  const challenge = WebSubChallenge.safeParse(
    url.searchParams.get('hub.challenge'),
  );
  if (!challenge.success) {
    return new Response('Bad Request', { status: 400 });
  }

  const leaseSeconds =
    webSubMode.data === 'subscribe'
      ? WebSubLeaseQuery.safeParse(url.searchParams.get('hub.lease_seconds'))
      : undefined;
  if (leaseSeconds !== undefined && !leaseSeconds.success) {
    return new Response('Bad Request', { status: 400 });
  }

  const accepted = await subscription.confirmWebSubIntent(
    webSubMode.data,
    topic,
    leaseSeconds?.data,
  );
  if (!accepted) {
    return new Response('Not Found', { status: 404 });
  }

  return new Response(challenge.data, {
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
  const channelId = YouTubeChannelId.safeParse(request.params.channelId);
  if (!channelId.success) {
    return new Response('Not Found', { status: 404 });
  }

  const accepted = await env.YOUTUBE_SUBSCRIPTIONS.getByName(
    channelId.data,
  ).receiveWebSubNotification(
    await request.arrayBuffer(),
    request.headers.get('x-hub-signature'),
  );

  return new Response(null, { status: accepted ? 204 : 401 });
}
