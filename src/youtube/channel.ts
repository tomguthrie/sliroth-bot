import { XMLParser } from 'fast-xml-parser';
import * as z from 'zod';

import { YouTubeChannelId, YouTubeHandle } from './data';

const YOUTUBE_CHANNEL_FEED_URL = 'https://www.youtube.com/feeds/videos.xml';
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
]);

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

const UnknownRecord = z.record(z.string(), z.unknown());
const YouTubeChannelFeed = z.object({
  title: z.string().refine((value) => value.trim() !== ''),
});

/** Builds the readable channel feed URL, not the WebSub topic URL. */
export function createYouTubeChannelFeedUrl(
  channelId: YouTubeChannelId,
): string {
  const url = new URL(YOUTUBE_CHANNEL_FEED_URL);
  url.searchParams.set('channel_id', channelId);
  return url.toString();
}

/** Fetches the current display title for a YouTube channel. */
export async function fetchYouTubeChannelTitle(
  channelId: YouTubeChannelId,
): Promise<string> {
  const response = await fetch(createYouTubeChannelFeedUrl(channelId));
  if (!response.ok) {
    if (response.body !== null) {
      await response.body.cancel();
    }
    throw new Error(`YouTube channel feed returned HTTP ${response.status}`);
  }

  const documentResult = UnknownRecord.safeParse(
    parser.parse(await response.text()),
  );
  const feedResult = UnknownRecord.safeParse(
    documentResult.success ? documentResult.data.feed : undefined,
  );
  if (!feedResult.success) {
    throw new Error('YouTube channel feed must contain an Atom feed');
  }

  const channelResult = YouTubeChannelFeed.safeParse(feedResult.data);
  if (!channelResult.success) {
    throw new Error('YouTube channel feed must contain a title');
  }
  return channelResult.data.title;
}

export interface ResolvedYouTubeChannel {
  id: YouTubeChannelId;
  title: string;
}

/** Resolves a YouTube channel ID, handle, or channel URL without the Data API. */
export async function resolveYouTubeChannel(
  input: string,
): Promise<ResolvedYouTubeChannel> {
  const value = input.trim();
  if (value === '') {
    throw new YouTubeChannelResolutionError('YouTube channel cannot be empty');
  }

  let parsed: ReturnType<typeof parseYouTubeChannelInput>;
  try {
    parsed = parseYouTubeChannelInput(value);
  } catch (error) {
    if (error instanceof YouTubeChannelResolutionError) throw error;
    throw new YouTubeChannelResolutionError('Invalid YouTube channel', {
      cause: error,
    });
  }
  const id =
    parsed.type === 'id'
      ? parsed.value
      : await resolveYouTubeHandle(parsed.value);

  try {
    return { id, title: await fetchYouTubeChannelTitle(id) };
  } catch (error) {
    throw new YouTubeChannelResolutionError(
      'YouTube channel could not be loaded',
      { cause: error },
    );
  }
}

export class YouTubeChannelResolutionError extends Error {}

function parseYouTubeChannelInput(input: string):
  | {
      type: 'id';
      value: YouTubeChannelId;
    }
  | {
      type: 'handle';
      value: YouTubeHandle;
    } {
  const channelId = YouTubeChannelId.safeParse(input);
  if (channelId.success) {
    return { type: 'id', value: channelId.data };
  }

  if (!input.includes('://')) {
    return { type: 'handle', value: YouTubeHandle.parse(input) };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new YouTubeChannelResolutionError('Invalid YouTube URL', {
      cause: error,
    });
  }

  if (
    url.protocol !== 'https:' ||
    !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new YouTubeChannelResolutionError('URL must be a YouTube URL');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const pathChannelId = YouTubeChannelId.safeParse(segments[1]);
  if (segments[0] === 'channel' && pathChannelId.success) {
    return { type: 'id', value: pathChannelId.data };
  }
  if (segments[0]?.startsWith('@')) {
    return { type: 'handle', value: YouTubeHandle.parse(segments[0]) };
  }

  throw new YouTubeChannelResolutionError(
    'URL must identify a YouTube channel or handle',
  );
}

async function resolveYouTubeHandle(
  handle: YouTubeHandle,
): Promise<YouTubeChannelId> {
  const url = new URL(
    `@${encodeURIComponent(handle)}`,
    'https://www.youtube.com/',
  );
  const response = await fetch(url);
  if (!response.ok) {
    if (response.body !== null) {
      await response.body.cancel();
    }
    throw new YouTubeChannelResolutionError(
      `YouTube handle returned HTTP ${response.status}`,
    );
  }

  const match = /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(
    await response.text(),
  );
  if (match?.[1] === undefined) {
    throw new YouTubeChannelResolutionError(
      'YouTube handle page did not contain a channel ID',
    );
  }
  return YouTubeChannelId.parse(match[1]);
}
