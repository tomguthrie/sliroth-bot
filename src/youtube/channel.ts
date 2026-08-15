import { parse } from 'txml/txml';
import * as z from 'zod';

const YOUTUBE_CHANNEL_FEED_URL = 'https://www.youtube.com/feeds/videos.xml';

const XML_PARSE_OPTIONS = {
  decodeEntities: true,
  selfClosingTags: [],
  simplify: true,
};

const YouTubeChannelFeed = z.object({
  feed: z.object({
    title: z.string().trim().min(1),
  }),
});

/** A resolved YouTube channel. */
export interface YouTubeChannel {
  id: string;
  title: string;
}

/** Returns whether the input is a YouTube channel ID. */
export function isYouTubeChannelId(input: string): boolean {
  return /^UC[A-Za-z0-9_-]{22}$/.test(input);
}

/** Returns whether the input is a normalized YouTube handle. */
export function isYouTubeChannelHandle(input: string): boolean {
  return (
    input !== '' &&
    !input.startsWith('@') &&
    !/[\s/\\?#]/u.test(input) &&
    !isYouTubeChannelId(input)
  );
}

/** Extracts a channel ID from a bare ID or supported YouTube channel URL. */
export function parseYouTubeChannelId(input: string): string | undefined {
  const value = input.trim();
  if (isYouTubeChannelId(value)) return value;

  const pathname = parseYouTubeUrlPathname(value);
  const channelId =
    pathname === undefined
      ? undefined
      : /^\/channel\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];

  return channelId !== undefined && isYouTubeChannelId(channelId)
    ? channelId
    : undefined;
}

/** Extracts a handle from a bare handle or supported YouTube handle URL. */
export function parseYouTubeChannelHandle(input: string): string | undefined {
  const value = input.trim();
  const bareHandle = value.startsWith('@') ? value.slice(1) : value;
  if (isYouTubeChannelHandle(bareHandle)) return bareHandle;

  const pathname = parseYouTubeUrlPathname(value);
  const handle =
    pathname === undefined
      ? undefined
      : /^\/@([^/]+)(?:\/|$)/.exec(pathname)?.[1];

  return handle !== undefined && isYouTubeChannelHandle(handle)
    ? handle
    : undefined;
}

/** Builds the readable channel feed URL, not the WebSub topic URL. */
export function createYouTubeChannelFeedUrl(channelId: string): string {
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

  return YouTubeChannelFeed.parse(
    parse(await response.text(), XML_PARSE_OPTIONS),
  ).feed.title;
}

/** Resolves a YouTube channel ID, handle, or channel URL without the Data API. */
export async function resolveYouTubeChannel(
  input: string,
): Promise<YouTubeChannel | undefined> {
  const channelId = parseYouTubeChannelId(input);
  const handle =
    channelId === undefined ? parseYouTubeChannelHandle(input) : undefined;
  const id =
    channelId ??
    (handle === undefined ? undefined : await resolveYouTubeHandle(handle));
  if (id === undefined) return undefined;

  return { id, title: await fetchYouTubeChannelTitle(id) };
}

async function resolveYouTubeHandle(
  handle: string,
): Promise<string | undefined> {
  const url = new URL(
    `@${encodeURIComponent(handle)}`,
    'https://www.youtube.com/',
  );
  const response = await fetch(url);
  if (!response.ok) {
    if (response.body !== null) {
      await response.body.cancel();
    }
    throw new Error(`YouTube handle returned HTTP ${response.status}`);
  }

  const match = /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(
    await response.text(),
  );
  if (match?.[1] === undefined) {
    return undefined;
  }
  return match[1];
}

function parseYouTubeUrlPathname(input: string): string | undefined {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' &&
      /^(?:www\.|m\.)?youtube\.com$/i.test(url.hostname)
      ? url.pathname
      : undefined;
  } catch {
    return undefined;
  }
}
