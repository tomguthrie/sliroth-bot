import * as z from 'zod';

import { parseYouTubeXml } from './xml';

export const YouTubeVideoNotification = z.object({
  videoId: z.string().trim().min(1),
  channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
  title: z.string().trim().min(1),
  publishedAt: z.iso.datetime({ offset: true }),
});

export type YouTubeVideoNotification = z.infer<typeof YouTubeVideoNotification>;

const YouTubeAtomEntry = z
  .object({
    'yt:videoId': z.string(),
    'yt:channelId': z.string(),
    title: z.string(),
    published: z.string(),
  })
  .transform(
    ({ 'yt:videoId': videoId, 'yt:channelId': channelId, title, published: publishedAt }) => ({
      videoId,
      channelId,
      title,
      publishedAt,
    }),
  )
  .pipe(YouTubeVideoNotification);
const YouTubeAtomFeed = z.object({
  feed: z.object({
    entry: z.union([YouTubeAtomEntry, z.array(YouTubeAtomEntry)]).optional(),
  }),
});

export function parseYouTubeVideoNotifications(xml: string): YouTubeVideoNotification[] {
  const entryValue = YouTubeAtomFeed.parse(parseYouTubeXml(xml)).feed.entry;

  if (entryValue === undefined) {
    return [];
  }

  return Array.isArray(entryValue) ? entryValue : [entryValue];
}
