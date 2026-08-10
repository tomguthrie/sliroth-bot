import * as z from 'zod';

import { YouTubeChannelId, YouTubeWebSubSecret } from './data';

export const YOUTUBE_WEBSUB_HUB_URL =
  'https://pubsubhubbub.appspot.com/subscribe';

const YOUTUBE_FEED_URL = 'https://www.youtube.com/xml/feeds/videos.xml';
const HttpOrigin = z
  .url({ protocol: /^https?$/ })
  .transform((value) => new URL(value).origin);
const YouTubeWebSubSignature = z
  .string()
  .regex(/^sha1=[0-9a-f]{40}$/i)
  .transform((value) => value.slice('sha1='.length));

export const WebSubMode = z.enum(['subscribe', 'unsubscribe']);

export type WebSubMode = z.infer<typeof WebSubMode>;

export const WebSubLeaseSeconds = z
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .brand<'WebSubLeaseSeconds'>();

export type WebSubLeaseSeconds = z.infer<typeof WebSubLeaseSeconds>;

export const CreateYouTubeWebSubRequestOptions = z.object({
  mode: WebSubMode,
  channelId: YouTubeChannelId,
  publicBaseUrl: HttpOrigin,
  secret: YouTubeWebSubSecret,
});

export type CreateYouTubeWebSubRequestOptions = z.infer<
  typeof CreateYouTubeWebSubRequestOptions
>;

export function createYouTubeTopicUrl(channelId: YouTubeChannelId): string {
  const topicUrl = new URL(YOUTUBE_FEED_URL);
  topicUrl.searchParams.set('channel_id', channelId);

  return topicUrl.toString();
}

export function createYouTubeWebSubRequest(
  options: z.input<typeof CreateYouTubeWebSubRequestOptions>,
): Request {
  const { mode, channelId, publicBaseUrl, secret } =
    CreateYouTubeWebSubRequestOptions.parse(options);
  const body = new URLSearchParams({
    'hub.mode': mode,
    'hub.topic': createYouTubeTopicUrl(channelId),
    'hub.callback': new URL(
      `/youtube/websub/${encodeURIComponent(channelId)}`,
      publicBaseUrl,
    ).toString(),
    'hub.secret': secret,
  });

  return new Request(YOUTUBE_WEBSUB_HUB_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
  });
}

export function createYouTubeCallbackUrl(
  publicBaseUrl: string,
  channelId: YouTubeChannelId,
): string {
  return new URL(
    `/youtube/websub/${encodeURIComponent(channelId)}`,
    HttpOrigin.parse(publicBaseUrl),
  ).toString();
}

export async function verifyYouTubeWebSubSignature(
  body: ArrayBuffer,
  signatureHeader: string | null,
  secret: YouTubeWebSubSecret,
): Promise<boolean> {
  const result = YouTubeWebSubSignature.safeParse(signatureHeader);
  if (!result.success) {
    return false;
  }

  const signature = hexToBytes(result.data);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-1',
    },
    false,
    ['verify'],
  );

  return crypto.subtle.verify('HMAC', key, signature, body);
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    const offset = index * 2;
    bytes[index] = Number.parseInt(hex.slice(offset, offset + 2), 16);
  }

  return bytes;
}
