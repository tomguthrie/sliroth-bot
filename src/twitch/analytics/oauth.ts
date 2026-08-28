import * as z from 'zod';

const OAuthToken = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.int().positive(),
  scope: z.array(z.string()),
});

export type TwitchOAuthToken = z.output<typeof OAuthToken>;

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

export async function revokeUserToken(
  clientId: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch('https://id.twitch.tv/oauth2/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, token: accessToken }),
  });
  if (!response.ok) {
    throw new TwitchOAuthError(
      `Twitch OAuth revocation returned HTTP ${response.status}: ${response.statusText}`,
      response.status,
    );
  }
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
