import { describe, expect, it, vi } from 'vitest';

import { resolveTwitchChannel } from '../../src/twitch/channel';
import type { TwitchApiClient, TwitchUser } from '../../src/twitch/client';
import { TwitchBroadcasterId, TwitchLogin } from '../../src/twitch/data';

const USER: TwitchUser = {
  id: TwitchBroadcasterId.parse('123'),
  login: TwitchLogin.parse('sliroth'),
  displayName: 'Sliroth',
  profileImageUrl: 'https://example.com/profile.png',
  offlineImageUrl: 'https://example.com/offline.png',
};

function client() {
  return {
    getUserById: vi.fn().mockResolvedValue(USER),
    getUserByLogin: vi.fn().mockResolvedValue(USER),
  } satisfies Pick<TwitchApiClient, 'getUserById' | 'getUserByLogin'>;
}

describe('resolveTwitchChannel', () => {
  it('resolves a numeric broadcaster ID', async () => {
    const twitch = client();

    await expect(resolveTwitchChannel('123', twitch)).resolves.toBe(USER);
    expect(twitch.getUserById).toHaveBeenCalledWith('123');
    expect(twitch.getUserByLogin).not.toHaveBeenCalled();
  });

  it.each([
    'sliroth',
    '@sliroth',
    'https://twitch.tv/sliroth',
    'https://www.twitch.tv/sliroth/videos',
    'https://m.twitch.tv/sliroth/about',
  ])('resolves a Twitch login input: %s', async (input) => {
    const twitch = client();

    await expect(resolveTwitchChannel(input, twitch)).resolves.toBe(USER);
    expect(twitch.getUserByLogin).toHaveBeenCalledWith('sliroth');
  });

  it.each([
    '',
    'not a login',
    'https://example.com/sliroth',
    'http://twitch.tv/sliroth',
    'https://twitch.tv/directory',
    'https://twitch.tv/',
  ])('rejects an unsupported channel input: %s', async (input) => {
    const twitch = client();

    await expect(resolveTwitchChannel(input, twitch)).rejects.toThrow();
    expect(twitch.getUserById).not.toHaveBeenCalled();
    expect(twitch.getUserByLogin).not.toHaveBeenCalled();
  });

  it('reports a Twitch channel that does not exist', async () => {
    const twitch = client();
    twitch.getUserByLogin.mockResolvedValue(undefined);

    await expect(resolveTwitchChannel('missing', twitch)).rejects.toThrow(
      'was not found',
    );
  });
});
