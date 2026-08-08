import { XMLParser } from 'fast-xml-parser';

const YOUTUBE_CHANNEL_FEED_URL = 'https://www.youtube.com/feeds/videos.xml';
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
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

/** Builds the readable channel feed URL, not the WebSub topic URL. */
export function createYouTubeChannelFeedUrl(channelId: string): string {
  if (channelId.trim() === '') {
    throw new Error('YouTube channel ID cannot be empty');
  }

  const url = new URL(YOUTUBE_CHANNEL_FEED_URL);
  url.searchParams.set('channel_id', channelId);
  return url.toString();
}

/** Fetches the current display title for a YouTube channel. */
export async function fetchYouTubeChannelTitle(
  channelId: string,
): Promise<string> {
  const response = await fetch(createYouTubeChannelFeedUrl(channelId));
  if (!response.ok) {
    if (response.body !== null) {
      await response.body.cancel();
    }
    throw new Error(`YouTube channel feed returned HTTP ${response.status}`);
  }

  const parsed: unknown = parser.parse(await response.text());
  if (!isRecord(parsed) || !isRecord(parsed.feed)) {
    throw new Error('YouTube channel feed must contain an Atom feed');
  }

  const title = parsed.feed.title;
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('YouTube channel feed must contain a title');
  }
  return title;
}

export interface ResolvedYouTubeChannel {
  id: string;
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

  const parsed = parseYouTubeChannelInput(value);
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

function parseYouTubeChannelInput(input: string): {
  type: 'id' | 'handle';
  value: string;
} {
  if (YOUTUBE_CHANNEL_ID.test(input)) {
    return { type: 'id', value: input };
  }

  if (!input.includes('://')) {
    return { type: 'handle', value: requireYouTubeHandle(input) };
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
  if (segments[0] === 'channel' && YOUTUBE_CHANNEL_ID.test(segments[1] ?? '')) {
    return { type: 'id', value: segments[1] };
  }
  if (segments[0]?.startsWith('@')) {
    return { type: 'handle', value: requireYouTubeHandle(segments[0]) };
  }

  throw new YouTubeChannelResolutionError(
    'URL must identify a YouTube channel or handle',
  );
}

function requireYouTubeHandle(input: string): string {
  const handle = input.startsWith('@') ? input.slice(1) : input;
  if (
    handle === '' ||
    /[\s/\\?#]/u.test(handle) ||
    YOUTUBE_CHANNEL_ID.test(handle)
  ) {
    throw new YouTubeChannelResolutionError('Invalid YouTube handle');
  }
  return handle;
}

async function resolveYouTubeHandle(handle: string): Promise<string> {
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
  return match[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
