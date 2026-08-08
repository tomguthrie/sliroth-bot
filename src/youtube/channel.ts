import { XMLParser } from 'fast-xml-parser';

const YOUTUBE_CHANNEL_FEED_URL = 'https://www.youtube.com/feeds/videos.xml';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
