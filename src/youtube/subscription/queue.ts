import type { QueueMessageProcessor } from '../../queue/message';
import type { YouTubeVideoNotification } from '../notification';

export interface YouTubeVideoDelivery {
  kind: 'youtube-video';
  channelId: string;
  notification: YouTubeVideoNotification;
}

/** Records a queued YouTube notification in its channel subscription. */
export const processYouTubeSubscriptionEvent: QueueMessageProcessor<
  YouTubeVideoDelivery
> = async (delivery, env) => {
  await env.YOUTUBE_SUBSCRIPTIONS.getByName(delivery.channelId).recordVideo(
    delivery.notification,
  );
  return { action: 'ack' };
};
