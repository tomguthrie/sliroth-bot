export const YOUTUBE_WEBSUB_HUB_URL =
  'https://pubsubhubbub.appspot.com/subscribe';

const YOUTUBE_FEED_URL = 'https://www.youtube.com/feeds/videos.xml';

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
  const callbackUrl = new URL(
    `youtube/websub/${encodeURIComponent(callbackToken)}`,
    publicBaseUrl,
  );

  const body = new URLSearchParams({
    'hub.mode': mode,
    'hub.topic': createYouTubeTopicUrl(channelId),
    'hub.callback': callbackUrl.toString(),
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
