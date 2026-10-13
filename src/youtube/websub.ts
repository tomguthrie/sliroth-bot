export const YOUTUBE_WEBSUB_HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';

const YOUTUBE_FEED_URL = 'https://www.youtube.com/xml/feeds/videos.xml';
export type WebSubMode = 'subscribe' | 'unsubscribe';

export interface CreateYouTubeWebSubRequestOptions {
  mode: WebSubMode;
  channelId: string;
  publicBaseUrl: string;
  secret: string;
}

export function createYouTubeTopicUrl(channelId: string): string {
  const topicUrl = new URL(YOUTUBE_FEED_URL);
  topicUrl.searchParams.set('channel_id', channelId);

  return topicUrl.toString();
}

export function createYouTubeWebSubRequest(options: CreateYouTubeWebSubRequestOptions): Request {
  const { mode, channelId, secret } = options;
  const publicBaseUrl = httpOrigin(options.publicBaseUrl);
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

export async function verifyYouTubeWebSubSignature(
  body: ArrayBuffer,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (signatureHeader === null || !/^sha1=[0-9a-f]{40}$/i.test(signatureHeader)) {
    return false;
  }

  const signature = Uint8Array.fromHex(signatureHeader.slice('sha1='.length));
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

function httpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WebSub public base URL must use HTTP or HTTPS');
  }
  return url.origin;
}
