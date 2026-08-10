import * as z from 'zod';

import { toLoggableError } from '../log';

export const TWITCH_TOKEN_KEY = 'twitch';
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/** Identifies an invalid response from Twitch's authorization service. */
export class TwitchAuthError extends Error {}

const TwitchTokenResponse = z
  .object({
    access_token: z.string(),
    expires_in: z.number(),
  })
  .transform(({ access_token: accessToken, expires_in: expiresIn }) => ({
    accessToken,
    expiresIn,
  }));

/** Returns the cached Twitch app token or requests and caches a new one. */
export async function getValidToken(env: Env): Promise<string> {
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

async function readCachedToken(env: Env): Promise<string | undefined> {
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
  if (isUsableAccessToken(cached)) {
    return cached;
  }

  console.warn({ event: 'twitch_token_cache_invalid' });
  try {
    await env.TOKEN_STORE.delete(TWITCH_TOKEN_KEY);
  } catch (error) {
    logCacheFailure('twitch_token_cache_delete_failed', error);
  }
  return undefined;
}

async function requestTwitchToken(env: Env) {
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
      throw new TwitchAuthError(
        `Twitch app access token returned HTTP ${response.status}`,
      );
    }

    stage = 'token_response';
    const result = TwitchTokenResponse.safeParse(await response.json());
    if (!result.success) {
      throw new TwitchAuthError(
        'Twitch app access token response was unusable',
        { cause: result.error },
      );
    }
    const { accessToken, expiresIn } = result.data;
    const expirationTtl =
      typeof expiresIn === 'number' ? Math.floor(expiresIn * 0.8) : Number.NaN;
    if (
      !isUsableAccessToken(accessToken) ||
      !Number.isSafeInteger(expirationTtl) ||
      expirationTtl < 60
    ) {
      throw new TwitchAuthError(
        'Twitch app access token response was unusable',
      );
    }

    return { accessToken, expirationTtl };
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

function isUsableAccessToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  try {
    new Headers({ authorization: `Bearer ${value}` });
    return true;
  } catch {
    return false;
  }
}
