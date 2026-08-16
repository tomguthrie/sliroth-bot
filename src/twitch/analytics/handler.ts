import { toLoggableError } from '../../log';

const CALLBACK_PATH = '/twitch/analytics/callback';

/** Starts broadcaster authorization for the configured analytics channel. */
export async function handleTwitchAnalyticsSetup(
  request: Request,
  env: Env,
): Promise<Response> {
  if (
    !(await hasValidSetupSecret(
      request.headers.get('authorization'),
      env.TWITCH_ANALYTICS_SETUP_SECRET,
    ))
  ) {
    return new Response('Unauthorized', { status: 401 });
  }

  const redirectUri = new URL(CALLBACK_PATH, env.PUBLIC_BASE_URL).toString();
  const authorizationUrl = await env.TWITCH_SUBSCRIPTIONS.getByName(
    env.TWITCH_ANALYTICS_CHANNEL_ID,
  ).beginAnalyticsAuthorization(redirectUri);
  return Response.redirect(authorizationUrl, 302);
}

/** Completes broadcaster authorization and enables analytics capture. */
export async function handleTwitchAnalyticsCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');
  if (providerError !== null) {
    return new Response(`Twitch authorization declined: ${providerError}`, {
      status: 400,
    });
  }
  if (code === null || state === null) {
    return new Response('Missing Twitch authorization response', {
      status: 400,
    });
  }

  try {
    const redirectUri = new URL(CALLBACK_PATH, env.PUBLIC_BASE_URL).toString();
    const result = await env.TWITCH_SUBSCRIPTIONS.getByName(
      env.TWITCH_ANALYTICS_CHANNEL_ID,
    ).completeAnalyticsAuthorization(code, state, redirectUri);
    return new Response(
      `Twitch analytics enabled for ${result.login}. You may close this window.`,
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  } catch (error) {
    console.error({
      event: 'twitch_analytics_authorization_failed',
      error: toLoggableError(error),
    });
    return new Response('Unable to enable Twitch analytics', { status: 400 });
  }
}

async function hasValidSetupSecret(
  authorization: string | null,
  expectedSecret: string,
): Promise<boolean> {
  if (!authorization?.startsWith('Bearer ')) return false;
  const supplied = authorization.slice('Bearer '.length);
  const encoder = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedSecret)),
  ]);
  return crypto.subtle.timingSafeEqual(suppliedHash, expectedHash);
}
