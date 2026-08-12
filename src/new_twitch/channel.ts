import { TwitchApiClient, TwitchUser } from './client';

/** Returns whether the input is a numeric Twitch broadcaster ID. */
export function isTwitchChannelId(input: string): boolean {
  return /^\d+$/.test(input);
}

/** Returns whether the input is a valid Twitch login name. */
export function isTwitchChannelLogin(input: string): boolean {
  return /^[a-zA-Z0-9_]{4,25}$/.test(input);
}

/**
 * Parses a Twitch channel name from either a bare login name or a Twitch channel URL.
 *
 * @param input Twitch login or channel URL.
 * @returns The channel login, or `undefined` if the input is not a supported
 * Twitch channel reference.
 */
export function parseTwitchChannelLogin(input: string): string | undefined {
  if (isTwitchChannelLogin(input)) {
    return input;
  }

  const match =
    /^https?:\/\/(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{4,25})\/?$/.exec(input);

  return match?.[1];
}

/**
 * Resolves a Twitch broadcaster ID, login name, or channel URL to a Twitch user.
 *
 * @param input Twitch broadcaster ID, login name, or channel URL.
 * @param env Cloudflare Worker bindings used to access the Twitch API.
 * @returns The matching Twitch user, or `undefined` if the input is invalid or
 * no matching user exists.
 * @throws If the Twitch API request fails or returns an invalid response.
 */
export async function resolveTwitchChannel(
  input: string,
  env: Env,
): Promise<TwitchUser | undefined> {
  const client = new TwitchApiClient(env);

  if (isTwitchChannelId(input)) {
    return client.getUserById(input);
  }

  const login = parseTwitchChannelLogin(input);

  if (login !== undefined) {
    return client.getUserByLogin(login);
  }

  return undefined;
}
