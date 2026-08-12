import * as z from 'zod';

const ACCESS_TOKEN_KEY = 'twitch';

const AccessToken = z
  .object({
    access_token: z.string(),
    expires_in: z.number(),
  })
  .transform((data) => ({
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  }));

type AccessToken = z.infer<typeof AccessToken>;

/**
 * Returns an application access token for Twitch API requests.
 *
 * Uses a cached token when available and otherwise obtains and caches a new
 * token using the configured Twitch client credentials.
 *
 * @param env Cloudflare Worker bindings containing Twitch credentials and the
 * token store.
 * @returns A Twitch application access token.
 * @throws If Twitch rejects the token request or returns an invalid response.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const cached = await loadCachedAccessToken(env);
  if (cached !== null) {
    return cached;
  }

  const token = await fetchAccessToken(env);

  await env.TOKEN_STORE.put(ACCESS_TOKEN_KEY, token.accessToken, {
    expirationTtl: token.expiresIn * 0.8,
  });

  return token.accessToken;
}

async function loadCachedAccessToken(env: Env): Promise<string | null> {
  return env.TOKEN_STORE.get(ACCESS_TOKEN_KEY);
}

async function fetchAccessToken(env: Env): Promise<AccessToken> {
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch access token: ${response.status} ${response.statusText}`,
    );
  }

  return AccessToken.parse(await response.json());
}
