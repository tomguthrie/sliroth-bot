import type { YouTubeVideoNotification } from '../notification';

export interface YouTubeVideoDelivery {
  kind: 'youtube-video';
  channelId: string;
  notification: YouTubeVideoNotification;
}

/** Records a queued YouTube notification in its channel subscription. */
export async function processYouTubeSubscriptionEvent(
  delivery: YouTubeVideoDelivery,
  env: Env,
): Promise<void> {
  await env.YOUTUBE_SUBSCRIPTIONS.getByName(delivery.channelId).recordVideo(
    delivery.notification,
  );
}
