import * as z from 'zod';

import { toLoggableError } from '../log';

export const TWITCH_TOKEN_KEY = 'twitch';
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/** A non-empty Twitch access token that can be represented in HTTP headers. */
export const TwitchAccessToken = z
  .string()
  .regex(/^[A-Za-z0-9._~+/-]+=*$/)
  .brand<'TwitchAccessToken'>();

export type TwitchAccessToken = z.infer<typeof TwitchAccessToken>;

const TwitchTokenResponse = z
  .object({
    access_token: TwitchAccessToken,
    expires_in: z.int().min(75),
  })
  .transform(({ access_token: accessToken, expires_in: expiresIn }) => ({
    accessToken,
    expirationTtl: Math.floor(expiresIn * 0.8),
  }));

type TwitchTokenResponse = z.infer<typeof TwitchTokenResponse>;

/** Returns the cached Twitch app token or requests and caches a new one. */
export async function getValidToken(env: Env): Promise<TwitchAccessToken> {
  const cached = await readCachedToken(env);
  if (cached !== undefined) {
    return cached;
  }

  console.info({ event: 'twitch_token_cache_miss' });
  const { accessToken, expirationTtl } = await requestTwitchToken(env);
  let cachedToken = true;
  try {
    await env.TOKEN_STORE.put(TWITCH_TOKEN_KEY, accessToken, {
      expirationTtl,
    });
  } catch (error) {
    cachedToken = false;
    logCacheFailure('twitch_token_cache_write_failed', error);
  }
  console.info({
    event: 'twitch_token_acquired',
    expirationTtl,
    cached: cachedToken,
  });
  return accessToken;
}

async function readCachedToken(
  env: Env,
): Promise<TwitchAccessToken | undefined> {
  let cached: string | null;
  try {
    cached = await env.TOKEN_STORE.get(TWITCH_TOKEN_KEY);
  } catch (error) {
    logCacheFailure('twitch_token_cache_read_failed', error);
    return undefined;
  }
  if (cached === null) {
    return undefined;
  }
  const result = TwitchAccessToken.safeParse(cached);
  if (result.success) {
    return result.data;
  }

  console.warn({ event: 'twitch_token_cache_invalid' });
  try {
    await env.TOKEN_STORE.delete(TWITCH_TOKEN_KEY);
  } catch (error) {
    logCacheFailure('twitch_token_cache_delete_failed', error);
  }
  return undefined;
}

async function requestTwitchToken(env: Env): Promise<TwitchTokenResponse> {
  let stage = 'token_request';
  try {
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
      throw new Error(
        `Twitch app access token returned HTTP ${response.status}`,
      );
    }

    stage = 'token_response';
    const result = TwitchTokenResponse.safeParse(await response.json());
    if (!result.success) {
      throw new Error('Twitch app access token response was unusable', {
        cause: result.error,
      });
    }
    return result.data;
  } catch (error) {
    console.error({
      event: 'twitch_token_acquisition_failed',
      stage,
      error: toLoggableError(error),
    });
    throw error;
  }
}

function logCacheFailure(event: string, error: unknown): void {
  console.warn({ event, error: toLoggableError(error) });
}
