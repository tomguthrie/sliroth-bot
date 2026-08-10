import * as z from 'zod';

import { DiscordSnowflake } from '../discord/snowflake';

const NonBlankString = z.string().refine((value) => value.trim() !== '');

export const YouTubeSubscriptionMetadata = z.object({
  title: NonBlankString,
});

export type YouTubeSubscriptionMetadata = z.infer<
  typeof YouTubeSubscriptionMetadata
>;

export interface GuildYouTubeSubscription {
  discordChannelId: string;
  youtubeChannelId: string;
  youtubeChannelTitle: string;
}

/** Builds the guild-scoped lookup key for a YouTube subscription. */
export function guildSubscriptionKey(
  guildId: string,
  channelId: string,
  youtubeChannelId: string,
): string {
  return `guild:${guildId}:channel:${channelId}:youtube:${youtubeChannelId}`;
}

/** Builds the channel-scoped lookup key for a YouTube subscription. */
export function channelSubscriptionKey(
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
): Promise<string[]> {
  DiscordSnowflake.parse(channelId);
  const prefix = `channel:${channelId}:youtube:`;
  const page = await index.list({ prefix });

  return page.keys.flatMap((key) => {
    const youtubeChannelId = key.name.slice(prefix.length);
    if (youtubeChannelId === '' || youtubeChannelId.includes(':')) {
      console.warn({
        event: 'youtube_subscription_index_key_invalid',
        key: key.name,
      });
      return [];
    }
    return [youtubeChannelId];
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
  const parsedMetadata = YouTubeSubscriptionMetadata.safeParse(metadata);
  if (
    !DiscordSnowflake.safeParse(discordChannelId).success ||
    youtubeChannelId === '' ||
    youtubeChannelId.includes(':') ||
    !parsedMetadata.success
  ) {
    return undefined;
  }

  return {
    discordChannelId,
    youtubeChannelId,
    youtubeChannelTitle: parsedMetadata.data.title,
  };
}
