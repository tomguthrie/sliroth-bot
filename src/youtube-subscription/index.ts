import {
  isDiscordSnowflake,
  requireDiscordSnowflake,
} from '../discord/snowflake';

const YOUTUBE_TITLE_CACHE_PREFIX = 'youtube:';
const YOUTUBE_TITLE_CACHE_SUFFIX = ':title';

export interface GuildYouTubeSubscription {
  discordChannelId: string;
  youtubeChannelId: string;
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
  requireDiscordSnowflake(guildId, 'Discord guild ID');
  const prefix = `guild:${guildId}:channel:`;
  const subscriptions: GuildYouTubeSubscription[] = [];
  let cursor: string | undefined;

  do {
    const page = await index.list({ prefix, cursor });
    for (const key of page.keys) {
      const subscription = parseGuildSubscriptionKey(key.name, prefix);
      if (subscription === undefined) {
        console.warn({
          event: 'youtube_subscription_index_key_invalid',
          key: key.name,
        });
        continue;
      }
      subscriptions.push(subscription);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  return subscriptions;
}

/** Lists the YouTube channels configured for a Discord channel. */
export async function listChannelYouTubeSubscriptions(
  index: KVNamespace,
  channelId: string,
): Promise<string[]> {
  requireDiscordSnowflake(channelId, 'Discord channel ID');
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

/** Gets cached YouTube channel titles from KV. */
export async function getCachedYouTubeChannelTitles(
  index: KVNamespace,
  channelIds: readonly string[],
): Promise<Map<string, string>> {
  const uniqueChannelIds = Array.from(new Set(channelIds));
  const values = await index.get(uniqueChannelIds.map(youtubeChannelTitleKey));
  const titles = new Map<string, string>();

  for (const channelId of uniqueChannelIds) {
    const value = values.get(youtubeChannelTitleKey(channelId));
    if (typeof value === 'string' && value.trim() !== '') {
      titles.set(channelId, value);
    }
  }

  return titles;
}

/** Stores a YouTube channel title without expiry. */
export function cacheYouTubeChannelTitle(
  index: KVNamespace,
  channelId: string,
  title: string,
): Promise<void> {
  if (title.trim() === '') {
    throw new Error('YouTube channel title cannot be empty');
  }
  return index.put(youtubeChannelTitleKey(channelId), title);
}

function youtubeChannelTitleKey(channelId: string): string {
  if (channelId.trim() === '') {
    throw new Error('YouTube channel ID cannot be empty');
  }
  return `${YOUTUBE_TITLE_CACHE_PREFIX}${channelId}${YOUTUBE_TITLE_CACHE_SUFFIX}`;
}

function parseGuildSubscriptionKey(
  key: string,
  prefix: string,
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
  if (
    !isDiscordSnowflake(discordChannelId) ||
    youtubeChannelId === '' ||
    youtubeChannelId.includes(':')
  ) {
    return undefined;
  }

  return { discordChannelId, youtubeChannelId };
}
