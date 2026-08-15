import { parse } from 'txml/txml';
import * as z from 'zod';

import { YouTubeChannelId, YouTubeTimestamp, YouTubeVideoId } from './data';

const XML_PARSE_OPTIONS = {
  decodeEntities: true,
  selfClosingTags: [],
  simplify: true,
};

const UnknownRecord = z.record(z.string(), z.unknown());
export const YouTubeVideoNotification = z.object({
  videoId: YouTubeVideoId,
  channelId: YouTubeChannelId,
  title: z.string().trim().min(1),
  publishedAt: YouTubeTimestamp,
});

export type YouTubeVideoNotification = z.infer<typeof YouTubeVideoNotification>;

const YouTubeAtomEntry = z
  .object({
    'yt:videoId': z.string().trim().min(1).pipe(YouTubeVideoId),
    'yt:channelId': z.string().trim().min(1).pipe(YouTubeChannelId),
    title: z.string().trim().min(1),
    published: z.string().trim().min(1).pipe(YouTubeTimestamp),
  })
  .transform(
    ({
      'yt:videoId': videoId,
      'yt:channelId': channelId,
      title,
      published: publishedAt,
    }) => ({
      videoId,
      channelId,
      title,
      publishedAt,
    }),
  );
const YouTubeAtomEntries = z.array(YouTubeAtomEntry);

export function parseYouTubeVideoNotifications(
  xml: string,
): YouTubeVideoNotification[] {
  const documentResult = UnknownRecord.safeParse(parse(xml, XML_PARSE_OPTIONS));
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

  return YouTubeAtomEntries.parse(entries);
}
