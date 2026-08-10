import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createYouTubeChannelFeedUrl,
  fetchYouTubeChannelTitle,
  resolveYouTubeChannel,
} from '../../src/youtube/channel';
import { YouTubeChannelId } from '../../src/youtube/data';

const CHANNEL_ID = YouTubeChannelId.parse('UC_x5XG1OV2P6uZZ5FSM9Ttw');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('YouTube channel metadata', () => {
  it('uses the readable channel feed rather than the WebSub topic', () => {
    expect(createYouTubeChannelFeedUrl(CHANNEL_ID)).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    );
  });

  it('fetches the channel title from its Atom feed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>A channel</title></feed>',
      ),
    );

    await expect(fetchYouTubeChannelTitle(CHANNEL_ID)).resolves.toBe(
      'A channel',
    );
  });

  it('rejects a feed without a title', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<feed xmlns="http://www.w3.org/2005/Atom"><id>channel</id></feed>',
      ),
    );

    await expect(fetchYouTubeChannelTitle(CHANNEL_ID)).rejects.toThrow(
      'must contain a title',
    );
  });

  it.each([
    CHANNEL_ID,
    `https://www.youtube.com/channel/${CHANNEL_ID}`,
    `https://m.youtube.com/channel/${CHANNEL_ID}/videos`,
  ])('resolves a channel ID input: %s', async (input) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<feed><title>Google for Developers</title></feed>'),
    );

    await expect(resolveYouTubeChannel(input)).resolves.toEqual({
      id: CHANNEL_ID,
      title: 'Google for Developers',
    });
  });

  it.each(['@GoogleDevelopers', 'GoogleDevelopers'])(
    'resolves a handle input: %s',
    async (input) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(`before "externalId":"${CHANNEL_ID}" after`),
        )
        .mockResolvedValueOnce(
          new Response('<feed><title>Google for Developers</title></feed>'),
        );

      await expect(resolveYouTubeChannel(input)).resolves.toEqual({
        id: CHANNEL_ID,
        title: 'Google for Developers',
      });
      const handleRequest = fetchSpy.mock.calls[0]?.[0];
      expect(
        handleRequest instanceof Request
          ? handleRequest.url
          : handleRequest?.toString(),
      ).toBe('https://www.youtube.com/@GoogleDevelopers');
    },
  );

  it('resolves a handle URL', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(`"externalId":"${CHANNEL_ID}"`))
      .mockResolvedValueOnce(
        new Response('<feed><title>A channel</title></feed>'),
      );

    await expect(
      resolveYouTubeChannel('https://youtube.com/@GoogleDevelopers/videos'),
    ).resolves.toEqual({ id: CHANNEL_ID, title: 'A channel' });
  });

  it.each([
    'https://example.com/@GoogleDevelopers',
    'https://youtube.com/watch?v=video',
    'https://youtube.com/user/legacy',
    'https://youtube.com/c/custom',
  ])('rejects an unsupported channel input: %s', async (input) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(resolveYouTubeChannel(input)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
