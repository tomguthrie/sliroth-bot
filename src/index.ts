import { createYouTubeCallbackUrl } from './youtube/websub';

export { YouTubeSubscription } from './durable/youtube-subscription';

export const YOUTUBE_SUBSCRIPTION_NAME = 'primary';

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);
    const callbackPath = new URL(
      createYouTubeCallbackUrl(env.PUBLIC_BASE_URL, env.YOUTUBE_CALLBACK_TOKEN),
    ).pathname;

    if (url.pathname !== callbackPath) {
      return notFound();
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          allow: 'GET',
        },
      });
    }

    return verifyYouTubeSubscription(url, env);
  },

  async scheduled(_controller, env, _ctx): Promise<void> {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      YOUTUBE_SUBSCRIPTION_NAME,
    );

    await subscription.requestSubscription();
  },
} satisfies ExportedHandler<Env>;

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

async function verifyYouTubeSubscription(
  url: URL,
  env: Env,
): Promise<Response> {
  const mode = url.searchParams.get('hub.mode');
  const topic = url.searchParams.get('hub.topic');
  const challenge = url.searchParams.get('hub.challenge');
  const rawLeaseSeconds = url.searchParams.get('hub.lease_seconds');

  if (
    mode !== 'subscribe' ||
    topic === null ||
    challenge === null ||
    challenge === '' ||
    rawLeaseSeconds === null ||
    !/^[1-9][0-9]*$/.test(rawLeaseSeconds)
  ) {
    return notFound();
  }

  const leaseSeconds = Number(rawLeaseSeconds);

  if (!Number.isSafeInteger(leaseSeconds)) {
    return notFound();
  }

  const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
    YOUTUBE_SUBSCRIPTION_NAME,
  );

  const confirmed = await subscription.confirmSubscription(topic, leaseSeconds);

  if (confirmed === null) {
    return notFound();
  }

  return new Response(challenge, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}
