import { describe, expect, it } from 'vitest';

import { YouTubeChannelId, YouTubeHandle } from '../../src/youtube/data';

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
});
