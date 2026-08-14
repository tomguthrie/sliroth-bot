import type { subscribers } from '../db/youtube-subscription/schema';
import {
  createDiscordMentionPayload,
  createDiscordMessageNonce,
  type DiscordMessage,
} from '../discord';
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
  const message: DiscordMessage = {
    content,
    nonce: await createDiscordMessageNonce(
      notification.videoId,
      subscriber.channelId,
    ),
    ...(mention.allowedMentions === undefined
      ? {}
      : { allowedMentions: mention.allowedMentions }),
  };

  return {
    operation: 'create',
    receiptTarget: { type: DISCORD_RECEIPT_IGNORE },
    guildId: subscriber.guildId,
    channelId: subscriber.channelId,
    message,
  };
}
