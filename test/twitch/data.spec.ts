import { describe, expect, it } from 'vitest';

import {
  TwitchBroadcasterId,
  TwitchEventSubSubscriptionId,
  TwitchGameId,
  TwitchLogin,
  TwitchStreamId,
  TwitchTimestamp,
  TwitchVideoId,
} from '../../src/twitch/data';

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

  it.each([
    [TwitchStreamId, 'stream-1'],
    [TwitchGameId, 'game-1'],
    [TwitchVideoId, 'video-1'],
    [TwitchEventSubSubscriptionId, 'eventsub-1'],
  ])('brands non-empty opaque identifiers', (schema, value) => {
    expect(schema.parse(value)).toBe(value);
    expect(schema.safeParse('').success).toBe(false);
  });

  it('brands ISO timestamps with an explicit offset', () => {
    expect(TwitchTimestamp.parse('2026-08-10T12:34:56Z')).toBe(
      '2026-08-10T12:34:56Z',
    );
    expect(TwitchTimestamp.safeParse('not-a-timestamp').success).toBe(false);
  });
});
