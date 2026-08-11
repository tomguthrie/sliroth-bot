import * as z from 'zod';

import { DiscordSnowflake } from '../discord/snowflake';
import { YouTubeChannelId } from '../youtube/data';

const NonBlankString = z.string().refine((value) => value.trim() !== '');

export const YouTubeSubscriptionMetadata = z.object({
  title: NonBlankString,
});

export type YouTubeSubscriptionMetadata = z.infer<
  typeof YouTubeSubscriptionMetadata
>;

export interface GuildYouTubeSubscription {
  discordChannelId: DiscordSnowflake;
  youtubeChannelId: YouTubeChannelId;
  youtubeChannelTitle: string;
}

/** Builds the guild-scoped lookup key for a YouTube subscription. */
export function createGuildYouTubeSubscriptionKey(
  guildId: string,
  channelId: string,
  youtubeChannelId: string,
): string {
  return `guild:${guildId}:channel:${channelId}:youtube:${youtubeChannelId}`;
}

/** Builds the channel-scoped lookup key for a YouTube subscription. */
export function createChannelYouTubeSubscriptionKey(
  channelId: string,
  youtubeChannelId: string,
): string {
  return `channel:${channelId}:youtube:${youtubeChannelId}`;
}

/** Lists every YouTube-to-Discord mapping indexed for a guild. */
export async function listGuildYouTubeSubscriptions(
  index: KVNamespace,
  guildId: string,
): Promise<GuildYouTubeSubscription[]> {
  DiscordSnowflake.parse(guildId);
  const prefix = `guild:${guildId}:channel:`;
  const page = await index.list<YouTubeSubscriptionMetadata>({ prefix });

  return page.keys.flatMap((key) => {
    const subscription = parseGuildSubscriptionKey(
      key.name,
      prefix,
      key.metadata,
    );
    if (subscription === undefined) {
      console.warn({
        event: 'youtube_subscription_index_key_invalid',
        key: key.name,
      });
      return [];
    }
    return [subscription];
  });
}

/** Lists the YouTube channels configured for a Discord channel. */
export async function listChannelYouTubeSubscriptions(
  index: KVNamespace,
  channelId: string,
): Promise<YouTubeChannelId[]> {
  DiscordSnowflake.parse(channelId);
  const prefix = `channel:${channelId}:youtube:`;
  const page = await index.list({ prefix });

  return page.keys.flatMap((key) => {
    const youtubeChannelId = YouTubeChannelId.safeParse(
      key.name.slice(prefix.length),
    );
    if (!youtubeChannelId.success) {
      console.warn({
        event: 'youtube_subscription_index_key_invalid',
        key: key.name,
      });
      return [];
    }
    return [youtubeChannelId.data];
  });
}

function parseGuildSubscriptionKey(
  key: string,
  prefix: string,
  metadata: unknown,
): GuildYouTubeSubscription | undefined {
  if (!key.startsWith(prefix)) {
    return undefined;
  }

  const suffix = key.slice(prefix.length);
  const separator = ':youtube:';
  const separatorOffset = suffix.indexOf(separator);
  if (separatorOffset === -1) {
    return undefined;
  }

  const discordChannelId = suffix.slice(0, separatorOffset);
  const youtubeChannelId = suffix.slice(separatorOffset + separator.length);
  const parsedDiscordChannelId = DiscordSnowflake.safeParse(discordChannelId);
  const parsedYouTubeChannelId = YouTubeChannelId.safeParse(youtubeChannelId);
  const parsedMetadata = YouTubeSubscriptionMetadata.safeParse(metadata);
  if (
    !parsedDiscordChannelId.success ||
    !parsedYouTubeChannelId.success ||
    !parsedMetadata.success
  ) {
    return undefined;
  }

  return {
    discordChannelId: parsedDiscordChannelId.data,
    youtubeChannelId: parsedYouTubeChannelId.data,
    youtubeChannelTitle: parsedMetadata.data.title,
  };
}
