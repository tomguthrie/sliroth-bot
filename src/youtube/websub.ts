export const YOUTUBE_WEBSUB_HUB_URL =
  'https://pubsubhubbub.appspot.com/subscribe';

const YOUTUBE_FEED_URL = 'https://www.youtube.com/feeds/videos.xml';
const YOUTUBE_SIGNATURE_PREFIX = 'sha1=';
const SHA1_HEX_LENGTH = 40;

export type WebSubMode = 'subscribe' | 'unsubscribe';

export interface CreateYouTubeWebSubRequestOptions {
  mode: WebSubMode;
  channelId: string;
  publicBaseUrl: string;
  callbackToken: string;
  secret: string;
}

export function createYouTubeTopicUrl(channelId: string): string {
  const topicUrl = new URL(YOUTUBE_FEED_URL);
  topicUrl.searchParams.set('channel_id', channelId);

  return topicUrl.toString();
}

export function createYouTubeWebSubRequest({
  mode,
  channelId,
  publicBaseUrl,
  callbackToken,
  secret,
}: CreateYouTubeWebSubRequestOptions): Request {
  const body = new URLSearchParams({
    'hub.mode': mode,
    'hub.topic': createYouTubeTopicUrl(channelId),
    'hub.callback': createYouTubeCallbackUrl(publicBaseUrl, callbackToken),
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
  callbackToken: string,
): string {
  return new URL(
    `/youtube/websub/${encodeURIComponent(callbackToken)}`,
    publicBaseUrl,
  ).toString();
}

export async function verifyYouTubeWebSubSignature(
  body: ArrayBuffer,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (signatureHeader === null) {
    return false;
  }

  if (!signatureHeader.startsWith(YOUTUBE_SIGNATURE_PREFIX)) {
    return false;
  }

  const signatureHex = signatureHeader.slice(YOUTUBE_SIGNATURE_PREFIX.length);

  if (
    signatureHex.length !== SHA1_HEX_LENGTH ||
    !/^[0-9a-f]+$/i.test(signatureHex)
  ) {
    return false;
  }

  const signature = hexToBytes(signatureHex);

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
