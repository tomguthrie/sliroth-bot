import * as z from 'zod';

const OAuthToken = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.int().positive(),
  scope: z.array(z.string()),
});

export type TwitchOAuthToken = z.output<typeof OAuthToken>;

const ValidatedToken = z.object({
  client_id: z.string(),
  login: z.string(),
  scopes: z.array(z.string()),
  user_id: z.string(),
  expires_in: z.int().nonnegative(),
});

export type ValidatedTwitchToken = z.output<typeof ValidatedToken>;

export async function exchangeAuthorizationCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<TwitchOAuthToken> {
  return requestOAuthToken(
    new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  );
}

export async function refreshUserToken(
  env: Env,
  refreshToken: string,
): Promise<TwitchOAuthToken> {
  return requestOAuthToken(
    new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
}

export async function validateUserToken(
  accessToken: string,
): Promise<ValidatedTwitchToken> {
  const response = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Twitch token validation returned HTTP ${response.status}: ${response.statusText}`,
    );
  }
  return ValidatedToken.parse(await response.json());
}

export function createOAuthState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashOAuthState(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(digest));
}

async function requestOAuthToken(
  body: URLSearchParams,
): Promise<TwitchOAuthToken> {
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Twitch OAuth returned HTTP ${response.status}: ${response.statusText}`,
    );
  }
  return OAuthToken.parse(await response.json());
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
