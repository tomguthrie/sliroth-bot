import { XMLParser } from 'fast-xml-parser';

export interface YouTubeVideoNotification {
  videoId: string;
  channelId: string;
  title: string;
  publishedAt: string;
}

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

export function parseYouTubeVideoNotifications(
  xml: string,
): YouTubeVideoNotification[] {
  const parsed: unknown = parser.parse(xml);

  if (!isRecord(parsed)) {
    throw new Error('YouTube notification must contain an XML document');
  }

  const feed = parsed.feed;

  if (!isRecord(feed)) {
    throw new Error('YouTube notification must contain an Atom feed');
  }

  const entryValue = feed.entry;

  if (entryValue === undefined) {
    return [];
  }

  const entries = Array.isArray(entryValue) ? entryValue : [entryValue];

  return entries.map(parseEntry);
}

function parseEntry(entry: unknown): YouTubeVideoNotification {
  if (!isRecord(entry)) {
    throw new Error('YouTube notification contains an invalid entry');
  }

  return {
    videoId: requireString(entry, 'videoId'),
    channelId: requireString(entry, 'channelId'),
    title: requireString(entry, 'title'),
    publishedAt: requireString(entry, 'published'),
  };
}

function requireString(
  record: Record<string, unknown>,
  property: string,
): string {
  const value = record[property];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `YouTube notification entry requires a non-empty ${property}`,
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
