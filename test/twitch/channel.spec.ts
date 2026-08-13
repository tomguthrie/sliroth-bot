import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isTwitchBroadcasterId,
  isTwitchChannelLogin,
  parseTwitchChannelLogin,
  resolveTwitchChannel,
} from '../../src/twitch/channel';

const { getUserById, getUserByLogin } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUserByLogin: vi.fn(),
}));

vi.mock('../../src/twitch/client', () => ({
  TwitchApiClient: class {
    getUserById = getUserById;
    getUserByLogin = getUserByLogin;
  },
}));

describe('isTwitchBroadcasterId', () => {
  it('accepts numeric broadcaster IDs', () => {
    expect(isTwitchBroadcasterId('123')).toBe(true);
    expect(isTwitchBroadcasterId('987654321')).toBe(true);
  });

  it('rejects non-numeric values', () => {
    expect(isTwitchBroadcasterId('sliroth')).toBe(false);
    expect(isTwitchBroadcasterId('123abc')).toBe(false);
    expect(isTwitchBroadcasterId('')).toBe(false);
    expect(isTwitchBroadcasterId(' 123 ')).toBe(false);
  });
});

describe('isTwitchChannelLogin', () => {
  it('accepts valid Twitch logins', () => {
    expect(isTwitchChannelLogin('sliroth')).toBe(true);
    expect(isTwitchChannelLogin('some_user')).toBe(true);
    expect(isTwitchChannelLogin('User123')).toBe(true);
  });

  it('rejects invalid Twitch logins', () => {
    expect(isTwitchChannelLogin('abc')).toBe(false);
    expect(isTwitchChannelLogin('this-login')).toBe(false);
    expect(isTwitchChannelLogin('has space')).toBe(false);
    expect(isTwitchChannelLogin('')).toBe(false);
    expect(isTwitchChannelLogin('a'.repeat(26))).toBe(false);
  });
});

describe('parseTwitchChannelName', () => {
  it('returns a bare Twitch login unchanged', () => {
    expect(parseTwitchChannelLogin('sliroth')).toBe('sliroth');
  });

  it('extracts the login from a Twitch channel URL', () => {
    expect(parseTwitchChannelLogin('https://twitch.tv/sliroth')).toBe(
      'sliroth',
    );
  });

  it('accepts www Twitch URLs', () => {
    expect(parseTwitchChannelLogin('https://www.twitch.tv/sliroth')).toBe(
      'sliroth',
    );
  });

  it('accepts a trailing slash', () => {
    expect(parseTwitchChannelLogin('https://twitch.tv/sliroth/')).toBe(
      'sliroth',
    );
  });

  it('accepts http Twitch URLs', () => {
    expect(parseTwitchChannelLogin('http://twitch.tv/sliroth')).toBe('sliroth');
  });

  it('rejects non-Twitch URLs', () => {
    expect(
      parseTwitchChannelLogin('https://example.com/sliroth'),
    ).toBeUndefined();
  });

  it('rejects non-channel Twitch URLs', () => {
    expect(
      parseTwitchChannelLogin('https://twitch.tv/directory/category'),
    ).toBeUndefined();
  });

  it('rejects invalid input', () => {
    expect(parseTwitchChannelLogin('not a channel')).toBeUndefined();
  });
});

describe('resolveTwitchChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves numeric input by broadcaster ID', async () => {
    const user = {
      id: '123',
      login: 'sliroth',
    };

    getUserById.mockResolvedValue(user);

    await expect(resolveTwitchChannel('123', env)).resolves.toBe(user);

    expect(getUserById).toHaveBeenCalledWith('123');
    expect(getUserByLogin).not.toHaveBeenCalled();
  });

  it('resolves a login by login name', async () => {
    const user = {
      id: '123',
      login: 'sliroth',
    };

    getUserByLogin.mockResolvedValue(user);

    await expect(resolveTwitchChannel('sliroth', env)).resolves.toBe(user);

    expect(getUserByLogin).toHaveBeenCalledWith('sliroth');
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('resolves a Twitch URL by extracted login', async () => {
    const user = {
      id: '123',
      login: 'sliroth',
    };

    getUserByLogin.mockResolvedValue(user);

    await expect(
      resolveTwitchChannel('https://twitch.tv/sliroth', env),
    ).resolves.toBe(user);

    expect(getUserByLogin).toHaveBeenCalledWith('sliroth');
  });

  it('returns undefined when the channel cannot be parsed', async () => {
    await expect(
      resolveTwitchChannel('not a twitch channel', env),
    ).resolves.toBeUndefined();

    expect(getUserById).not.toHaveBeenCalled();
    expect(getUserByLogin).not.toHaveBeenCalled();
  });

  it('returns undefined when Twitch does not find the channel', async () => {
    getUserByLogin.mockResolvedValue(undefined);

    await expect(resolveTwitchChannel('sliroth', env)).resolves.toBeUndefined();
  });
});
