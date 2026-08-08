export const TWITCH_TOKEN_KEY = 'twitch';
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/** Identifies an invalid response from Twitch's authorization service. */
export class TwitchAuthError extends Error {}

/** Returns the cached Twitch app token or requests and caches a new one. */
export async function getValidToken(env: Env): Promise<string> {
  const cached = await env.TOKEN_STORE.get(TWITCH_TOKEN_KEY);
  if (cached !== null) return cached;

  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    if (response.body !== null) await response.body.cancel();
    throw new TwitchAuthError(
      `Twitch app access token returned HTTP ${response.status}`,
    );
  }

  const { access_token: accessToken, expires_in: expiresIn } =
    await response.json<{ access_token: string; expires_in: number }>();

  await env.TOKEN_STORE.put(TWITCH_TOKEN_KEY, accessToken, {
    expirationTtl: Math.floor(expiresIn * 0.8),
  });
  return accessToken;
}
