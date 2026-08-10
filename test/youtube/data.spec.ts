import { describe, expect, it } from 'vitest';

import {
  YouTubeChannelId,
  YouTubeHandle,
  YouTubeTimestamp,
  YouTubeVideoId,
  YouTubeWebSubSecret,
} from '../../src/youtube/data';

describe('YouTube domain identifiers', () => {
  it('brands channel IDs', () => {
    expect(YouTubeChannelId.parse('UC_x5XG1OV2P6uZZ5FSM9Ttw')).toBe(
      'UC_x5XG1OV2P6uZZ5FSM9Ttw',
    );
    expect(YouTubeChannelId.safeParse('channel').success).toBe(false);
  });

  it('normalizes and brands handles', () => {
    expect(YouTubeHandle.parse('@GoogleDevelopers')).toBe('GoogleDevelopers');
    expect(YouTubeHandle.safeParse('not a handle').success).toBe(false);
    expect(YouTubeHandle.safeParse('UC_x5XG1OV2P6uZZ5FSM9Ttw').success).toBe(
      false,
    );
  });

  it('brands non-empty video IDs and WebSub secrets', () => {
    expect(YouTubeVideoId.parse('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(YouTubeVideoId.safeParse('').success).toBe(false);
    expect(YouTubeWebSubSecret.parse('websub-secret')).toBe('websub-secret');
    expect(YouTubeWebSubSecret.safeParse('').success).toBe(false);
  });

  it('brands ISO timestamps with an explicit offset', () => {
    expect(YouTubeTimestamp.parse('2026-08-10T12:34:56Z')).toBe(
      '2026-08-10T12:34:56Z',
    );
    expect(YouTubeTimestamp.safeParse('not-a-timestamp').success).toBe(false);
  });
});
