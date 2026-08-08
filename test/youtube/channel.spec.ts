import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createYouTubeChannelFeedUrl,
  fetchYouTubeChannelTitle,
} from '../../src/youtube/channel';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('YouTube channel metadata', () => {
  it('uses the readable channel feed rather than the WebSub topic', () => {
    expect(createYouTubeChannelFeedUrl('UC_CHANNEL')).toBe(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UC_CHANNEL',
    );
  });

  it('fetches the channel title from its Atom feed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>A channel</title></feed>',
      ),
    );

    await expect(fetchYouTubeChannelTitle('UC_CHANNEL')).resolves.toBe(
      'A channel',
    );
  });

  it('rejects a feed without a title', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<feed xmlns="http://www.w3.org/2005/Atom"><id>channel</id></feed>',
      ),
    );

    await expect(fetchYouTubeChannelTitle('UC_CHANNEL')).rejects.toThrow(
      'must contain a title',
    );
  });
});
