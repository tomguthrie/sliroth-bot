import type {
  SubscriberPing,
  subscribers,
} from '../db/youtube-subscription/schema';
import type { DiscordAllowedMentions } from '../discord/message';
import type { DiscordMessageDelivery } from '../queue/discord-message';
import { DISCORD_RECEIPT_IGNORE } from '../queue/discord-message';
import type { YouTubeVideoNotification } from '../youtube/notification';

const DEFAULT_MESSAGE = 'A new video has been uploaded!';
const MAX_DISCORD_NONCE_LENGTH = 25;

export type YouTubeSubscriber = typeof subscribers.$inferSelect;

/** Builds a queued Discord delivery for a YouTube subscriber. */
export async function createYouTubeDiscordMessage(
  notification: YouTubeVideoNotification,
  subscriber: YouTubeSubscriber,
): Promise<DiscordMessageDelivery> {
  const mention = createMention(subscriber.ping);
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

function createMention(ping: SubscriberPing | null): {
  content?: string;
  allowedMentions?: DiscordAllowedMentions;
} {
  if (ping === null) {
    return {};
  }

  if (ping === 'everyone' || ping === 'here') {
    return {
      content: `@${ping}`,
      allowedMentions: { everyone: true },
    };
  }

  return {
    content: `<@&${ping}>`,
    allowedMentions: { roleIds: [ping] },
  };
}

async function createDiscordNonce(
  videoId: string,
  channelId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${videoId}:${channelId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .slice(0, MAX_DISCORD_NONCE_LENGTH);
}
