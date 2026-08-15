import type { subscribers } from '../db/youtube-subscription/schema';
import {
  createDiscordMentionPayload,
  createDiscordMessage,
  createDiscordMessageNonce,
} from '../discord/message';
import type { DiscordMessageDelivery } from '../queue/discord-message';
import { DISCORD_RECEIPT_IGNORE } from '../queue/discord-message';
import type { YouTubeVideoNotification } from '../youtube';

const DEFAULT_MESSAGE = 'A new video has been uploaded!';

export type YouTubeSubscriber = typeof subscribers.$inferSelect;

/** Creates a queued Discord delivery for a YouTube subscriber. */
export async function createYouTubeDelivery(
  notification: YouTubeVideoNotification,
  subscriber: YouTubeSubscriber,
): Promise<DiscordMessageDelivery> {
  const mention = createDiscordMentionPayload(subscriber.ping);
  const content = [
    mention.content,
    subscriber.message ?? DEFAULT_MESSAGE,
    `https://youtu.be/${notification.videoId}`,
  ]
    .filter((part) => part !== undefined)
    .join(' ');
  const message = createDiscordMessage({
    content,
    nonce: await createDiscordMessageNonce(
      notification.videoId,
      subscriber.channelId,
    ),
    allowedMentions: mention.allowedMentions,
  });

  return {
    operation: 'create',
    receiptTarget: { type: DISCORD_RECEIPT_IGNORE },
    guildId: subscriber.guildId,
    channelId: subscriber.channelId,
    message,
  };
}
