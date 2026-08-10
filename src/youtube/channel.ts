import { XMLParser } from 'fast-xml-parser';
import * as z from 'zod';

import { YouTubeChannelId, YouTubeHandle } from './data';

const YOUTUBE_CHANNEL_FEED_URL = 'https://www.youtube.com/feeds/videos.xml';

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

const UnknownRecord = z.record(z.string(), z.unknown());
const YouTubeChannelFeed = z.object({
  title: z.string().refine((value) => value.trim() !== ''),
});
const YouTubeChannelUrl = z
  .url({
    protocol: /^https$/,
    hostname: /^(?:www\.|m\.)?youtube\.com$/i,
  })
  .transform((value) => new URL(value).pathname)
  .pipe(
    z.union([
      z
        .string()
        .regex(/^\/channel\/[^/]+(?:\/|$)/)
        .transform((pathname) =>
          pathname.replace(/^\/channel\/([^/]+).*$/, '$1'),
        )
        .pipe(YouTubeChannelId)
        .transform((value): { type: 'id'; value: YouTubeChannelId } => ({
          type: 'id',
          value,
        })),
      z
        .string()
        .regex(/^\/@[^/]+(?:\/|$)/)
        .transform((pathname) => pathname.replace(/^\/([^/]+).*$/, '$1'))
        .pipe(YouTubeHandle)
        .transform((value): { type: 'handle'; value: YouTubeHandle } => ({
          type: 'handle',
          value,
        })),
    ]),
  );
const YouTubeChannelReference = z
  .string()
  .trim()
  .min(1)
  .pipe(
    z.union([
      YouTubeChannelId.transform(
        (value): { type: 'id'; value: YouTubeChannelId } => ({
          type: 'id',
          value,
        }),
      ),
      YouTubeChannelUrl,
      YouTubeHandle.transform(
        (value): { type: 'handle'; value: YouTubeHandle } => ({
          type: 'handle',
          value,
        }),
      ),
    ]),
  );

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
  const reference = YouTubeChannelReference.safeParse(input);
  if (!reference.success) {
    throw new YouTubeChannelResolutionError('Invalid YouTube channel', {
      cause: reference.error,
    });
  }
  const id =
    reference.data.type === 'id'
      ? reference.data.value
      : await resolveYouTubeHandle(reference.data.value);

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
