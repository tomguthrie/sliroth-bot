import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import {
  createYouTubeChannelFeedUrl,
  fetchYouTubeChannelTitle,
  isYouTubeChannelHandle,
  isYouTubeChannelId,
  parseYouTubeChannelHandle,
  parseYouTubeChannelId,
  resolveYouTubeChannel,
} from '../../src/youtube/channel';

const CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isYouTubeChannelId', () => {
  it('accepts YouTube channel IDs', () => {
    expect(isYouTubeChannelId(CHANNEL_ID)).toBe(true);
  });

  it.each(['channel', `UC${'a'.repeat(21)}`, `UC${'a'.repeat(23)}`, ''])(
    'rejects %j',
    (input) => {
      expect(isYouTubeChannelId(input)).toBe(false);
    },
  );
});

describe('isYouTubeChannelHandle', () => {
  it.each(['GoogleDevelopers', 'google.developers', '日本語'])(
    'accepts the normalized handle %j',
    (input) => {
      expect(isYouTubeChannelHandle(input)).toBe(true);
    },
  );

  it.each(['', '@GoogleDevelopers', 'not a handle', 'has/slash', CHANNEL_ID])(
    'rejects %j',
    (input) => {
      expect(isYouTubeChannelHandle(input)).toBe(false);
    },
  );
});

describe('parseYouTubeChannelId', () => {
  it.each([
    CHANNEL_ID,
    `https://youtube.com/channel/${CHANNEL_ID}`,
    `https://www.youtube.com/channel/${CHANNEL_ID}/`,
    `https://m.youtube.com/channel/${CHANNEL_ID}/videos`,
  ])('extracts the channel ID from %s', (input) => {
    expect(parseYouTubeChannelId(input)).toBe(CHANNEL_ID);
  });

  it.each([
    'https://example.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
    'http://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
    'https://youtube.com/watch?v=video',
    'not a channel',
  ])('returns undefined for %s', (input) => {
    expect(parseYouTubeChannelId(input)).toBeUndefined();
  });
});

describe('parseYouTubeChannelHandle', () => {
  it.each([
    ['GoogleDevelopers', 'GoogleDevelopers'],
    ['@GoogleDevelopers', 'GoogleDevelopers'],
    ['https://youtube.com/@GoogleDevelopers', 'GoogleDevelopers'],
    ['https://www.youtube.com/@GoogleDevelopers/', 'GoogleDevelopers'],
    ['https://m.youtube.com/@GoogleDevelopers/videos', 'GoogleDevelopers'],
  ])('extracts the handle from %s', (input, expected) => {
    expect(parseYouTubeChannelHandle(input)).toBe(expected);
  });

  it.each([
    CHANNEL_ID,
    'https://example.com/@GoogleDevelopers',
    'https://youtube.com/watch?v=video',
    'not a handle',
  ])('returns undefined for %s', (input) => {
    expect(parseYouTubeChannelHandle(input)).toBeUndefined();
  });
});

describe('YouTube channel metadata', () => {
  it('builds the readable channel feed URL', () => {
    expect(createYouTubeChannelFeedUrl(CHANNEL_ID)).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    );
  });

  it('fetches the channel title from its Atom feed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<feed><title>Google for Developers</title></feed>'),
    );

    await expect(fetchYouTubeChannelTitle(CHANNEL_ID)).resolves.toBe(
      'Google for Developers',
    );
  });

  it('rejects a malformed channel feed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<feed><id>channel</id></feed>'),
    );

    await expect(fetchYouTubeChannelTitle(CHANNEL_ID)).rejects.toBeInstanceOf(
      z.ZodError,
    );
  });

  it('resolves a channel ID and title', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<feed><title>Google for Developers</title></feed>'),
    );

    await expect(resolveYouTubeChannel(CHANNEL_ID)).resolves.toEqual({
      id: CHANNEL_ID,
      title: 'Google for Developers',
    });
  });

  it('resolves a handle and title', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(`"externalId":"${CHANNEL_ID}"`))
      .mockResolvedValueOnce(
        new Response('<feed><title>Google for Developers</title></feed>'),
      );

    await expect(resolveYouTubeChannel('@GoogleDevelopers')).resolves.toEqual({
      id: CHANNEL_ID,
      title: 'Google for Developers',
    });
    expect(requestUrl(fetcher.mock.calls[0]?.[0])).toBe(
      'https://www.youtube.com/@GoogleDevelopers',
    );
  });

  it('returns undefined for invalid or unresolved input', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(
      resolveYouTubeChannel('https://youtube.com/watch?v=video'),
    ).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();

    fetcher.mockResolvedValueOnce(new Response('<html></html>'));
    await expect(
      resolveYouTubeChannel('@missing-channel'),
    ).resolves.toBeUndefined();
  });

  it('propagates provider request failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    await expect(resolveYouTubeChannel(CHANNEL_ID)).rejects.toThrow(
      'YouTube channel feed returned HTTP 503',
    );
  });
});

function requestUrl(input: RequestInfo | URL | undefined): string | undefined {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}
