import type { subscribers } from '../db/youtube-subscription/schema';
import {
  DiscordMention,
  DiscordNonce,
  DiscordMessageBuilder,
} from '../discord/message';
import type { DiscordMessageDelivery } from '../queue/discord-message';
import { DISCORD_RECEIPT_IGNORE } from '../queue/discord-message';
import type { YouTubeVideoNotification } from '../youtube/notification';

const DEFAULT_MESSAGE = 'A new video has been uploaded!';

export type YouTubeSubscriber = typeof subscribers.$inferSelect;

/** Builds queued Discord deliveries for YouTube subscribers. */
export class YouTubeDiscordMessage {
  static async build(
    notification: YouTubeVideoNotification,
    subscriber: YouTubeSubscriber,
  ): Promise<DiscordMessageDelivery> {
    const mention = DiscordMention.from(subscriber.ping);
    const content = [
      mention.content,
      subscriber.message ?? DEFAULT_MESSAGE,
      `https://youtu.be/${notification.videoId}`,
    ]
      .filter((part) => part !== undefined)
      .join(' ');
    const message = new DiscordMessageBuilder(content).setNonce(
      await DiscordNonce.from(notification.videoId, subscriber.channelId),
    );
    if (mention.allowedMentions !== undefined) {
      message.setAllowedMentions(mention.allowedMentions);
    }

    return {
      operation: 'create',
      receiptTarget: { type: DISCORD_RECEIPT_IGNORE },
      guildId: subscriber.guildId,
      channelId: subscriber.channelId,
      message: message.build(),
    };
  }
}
