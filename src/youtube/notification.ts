import { XMLParser } from 'fast-xml-parser';
import * as z from 'zod';

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

const UnknownRecord = z.record(z.string(), z.unknown());
export const YouTubeVideoNotification = z
  .object({
    videoId: nonBlankString('videoId'),
    channelId: nonBlankString('channelId'),
    title: nonBlankString('title'),
    published: nonBlankString('published'),
  })
  .transform(({ videoId, channelId, title, published: publishedAt }) => ({
    videoId,
    channelId,
    title,
    publishedAt,
  }));

export type YouTubeVideoNotification = z.infer<typeof YouTubeVideoNotification>;

export function parseYouTubeVideoNotifications(
  xml: string,
): YouTubeVideoNotification[] {
  const documentResult = UnknownRecord.safeParse(parser.parse(xml));
  if (!documentResult.success) {
    throw new Error('YouTube notification must contain an XML document');
  }

  const feed = documentResult.data.feed;

  const feedResult = UnknownRecord.safeParse(feed);
  if (!feedResult.success) {
    throw new Error('YouTube notification must contain an Atom feed');
  }

  const entryValue = feedResult.data.entry;

  if (entryValue === undefined) {
    return [];
  }

  const entries = Array.isArray(entryValue) ? entryValue : [entryValue];

  return entries.map(parseEntry);
}

function parseEntry(entry: unknown): YouTubeVideoNotification {
  const result = YouTubeVideoNotification.safeParse(entry);
  if (!result.success) {
    const message = result.error.issues[0]?.message;
    throw new Error(
      message ?? 'YouTube notification contains an invalid entry',
      { cause: result.error },
    );
  }
  return result.data;
}

function nonBlankString(property: string) {
  const error = `YouTube notification entry requires a non-empty ${property}`;
  return z.string({ error }).refine((value) => value.trim() !== '', { error });
}
