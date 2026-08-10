import type { TwitchApiClient, TwitchUser } from './client';
import { TwitchBroadcasterId, TwitchLogin } from './data';

const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);

export class TwitchChannelResolutionError extends Error {}

/** Resolves a Twitch login, numeric broadcaster ID, or channel URL. */
export async function resolveTwitchChannel(
  input: string,
  client: Pick<TwitchApiClient, 'getUserById' | 'getUserByLogin'>,
): Promise<TwitchUser> {
  const value = input.trim();
  if (value === '') {
    throw new TwitchChannelResolutionError('Twitch channel cannot be empty');
  }

  let parsed: ReturnType<typeof parseTwitchChannelInput>;
  try {
    parsed = parseTwitchChannelInput(value);
  } catch (error) {
    if (error instanceof TwitchChannelResolutionError) throw error;
    throw new TwitchChannelResolutionError('Invalid Twitch channel', {
      cause: error,
    });
  }
  let user: TwitchUser | undefined;
  try {
    user =
      parsed.type === 'id'
        ? await client.getUserById(parsed.value)
        : await client.getUserByLogin(parsed.value);
  } catch (error) {
    throw new TwitchChannelResolutionError(
      'Twitch channel could not be loaded',
      {
        cause: error,
      },
    );
  }
  if (user === undefined) {
    throw new TwitchChannelResolutionError('Twitch channel was not found');
  }
  return user;
}

function parseTwitchChannelInput(input: string):
  | {
      type: 'id';
      value: TwitchBroadcasterId;
    }
  | {
      type: 'login';
      value: TwitchLogin;
    } {
  const broadcasterId = TwitchBroadcasterId.safeParse(input);
  if (broadcasterId.success) {
    return { type: 'id', value: broadcasterId.data };
  }

  if (!input.includes('://')) {
    return { type: 'login', value: TwitchLogin.parse(input) };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new TwitchChannelResolutionError('Invalid Twitch URL', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    !TWITCH_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new TwitchChannelResolutionError('URL must be a Twitch URL');
  }

  const login = url.pathname.split('/').find((segment) => segment !== '');
  if (login === undefined) {
    throw new TwitchChannelResolutionError(
      'URL must identify a Twitch channel',
    );
  }
  return { type: 'login', value: TwitchLogin.parse(login) };
}
