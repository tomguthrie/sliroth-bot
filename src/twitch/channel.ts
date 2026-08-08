import type { TwitchApiClient, TwitchUser } from './client';

const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);
const TWITCH_LOGIN = /^[A-Za-z0-9_]{1,25}$/;
const RESERVED_PATHS = new Set([
  'directory',
  'downloads',
  'jobs',
  'p',
  'search',
  'settings',
  'subscriptions',
  'turbo',
  'videos',
  'wallet',
]);

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

  const parsed = parseTwitchChannelInput(value);
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

function parseTwitchChannelInput(input: string): {
  type: 'id' | 'login';
  value: string;
} {
  if (/^[0-9]+$/.test(input)) return { type: 'id', value: input };

  if (!input.includes('://')) {
    return { type: 'login', value: requireTwitchLogin(input) };
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
  if (login === undefined || RESERVED_PATHS.has(login.toLowerCase())) {
    throw new TwitchChannelResolutionError(
      'URL must identify a Twitch channel',
    );
  }
  return { type: 'login', value: requireTwitchLogin(login) };
}

function requireTwitchLogin(input: string): string {
  const login = input.startsWith('@') ? input.slice(1) : input;
  if (!TWITCH_LOGIN.test(login) || RESERVED_PATHS.has(login.toLowerCase())) {
    throw new TwitchChannelResolutionError('Invalid Twitch login');
  }
  return login;
}
