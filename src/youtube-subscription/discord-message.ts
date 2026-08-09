import type { subscribers } from '../db/youtube-subscription/schema';
import { createDiscordMention, createDiscordNonce } from '../discord/message';
import type { DiscordMessageDelivery } from '../queue/discord-message';
import { DISCORD_RECEIPT_IGNORE } from '../queue/discord-message';
import type { YouTubeVideoNotification } from '../youtube/notification';

const DEFAULT_MESSAGE = 'A new video has been uploaded!';

export type YouTubeSubscriber = typeof subscribers.$inferSelect;

/** Builds a queued Discord delivery for a YouTube subscriber. */
export async function createYouTubeDiscordMessage(
  notification: YouTubeVideoNotification,
  subscriber: YouTubeSubscriber,
): Promise<DiscordMessageDelivery> {
  const mention = createDiscordMention(subscriber.ping);
  const content = [
    mention.content,
    subscriber.message ?? DEFAULT_MESSAGE,
    `https://youtu.be/${notification.videoId}`,
  ]
    .filter((part) => part !== undefined)
    .join(' ');

  return {
    operation: 'create',
    receiptTarget: { type: DISCORD_RECEIPT_IGNORE },
    guildId: subscriber.guildId,
    channelId: subscriber.channelId,
    message: {
      content,
      nonce: await createDiscordNonce(
        notification.videoId,
        subscriber.channelId,
      ),
      allowedMentions: mention.allowedMentions,
    },
  };
}
