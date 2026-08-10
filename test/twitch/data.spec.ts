import { describe, expect, it } from 'vitest';

import { TwitchBroadcasterId, TwitchLogin } from '../../src/twitch/data';

describe('Twitch domain identifiers', () => {
  it('brands decimal broadcaster IDs', () => {
    expect(TwitchBroadcasterId.parse('123456789')).toBe('123456789');
    expect(TwitchBroadcasterId.safeParse('broadcaster').success).toBe(false);
  });

  it('normalizes and brands channel logins', () => {
    expect(TwitchLogin.parse('@sliroth')).toBe('sliroth');
    expect(TwitchLogin.safeParse('not a login').success).toBe(false);
    expect(TwitchLogin.safeParse('directory').success).toBe(false);
  });
});
