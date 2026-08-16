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

class TwitchTokenValidationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TwitchTokenValidationError';
  }
}

class TwitchOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TwitchOAuthError';
  }
}

/** Returns whether an unknown value is an OAuth-token HTTP error. */
export function isTwitchOAuthErrorStatus(
  error: unknown,
  status: number,
): boolean {
  return error instanceof TwitchOAuthError && error.status === status;
}

/** Returns whether an unknown value is a token-validation HTTP error. */
export function isTwitchTokenValidationErrorStatus(
  error: unknown,
  status: number,
): boolean {
  return error instanceof TwitchTokenValidationError && error.status === status;
}

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
    throw new TwitchTokenValidationError(
      `Twitch token validation returned HTTP ${response.status}: ${response.statusText}`,
      response.status,
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
    throw new TwitchOAuthError(
      `Twitch OAuth returned HTTP ${response.status}: ${response.statusText}`,
      response.status,
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
