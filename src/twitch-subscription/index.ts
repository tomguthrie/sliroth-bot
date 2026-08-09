import {
  isDiscordSnowflake,
  requireDiscordSnowflake,
} from '../discord/snowflake';

export interface GuildTwitchSubscription {
  discordChannelId: string;
  twitchBroadcasterId: string;
}

/** Builds the guild-scoped lookup key for a Twitch subscription. */
export function guildTwitchSubscriptionKey(
  guildId: string,
  channelId: string,
  broadcasterId: string,
): string {
  return `guild:${guildId}:channel:${channelId}:twitch:${broadcasterId}`;
}

/** Builds the channel-scoped lookup key for a Twitch subscription. */
export function channelTwitchSubscriptionKey(
  channelId: string,
  broadcasterId: string,
): string {
  return `channel:${channelId}:twitch:${broadcasterId}`;
}

/** Lists every Twitch-to-Discord mapping indexed for a guild. */
export async function listGuildTwitchSubscriptions(
  index: KVNamespace,
  guildId: string,
): Promise<GuildTwitchSubscription[]> {
  requireDiscordSnowflake(guildId, 'Discord guild ID');
  const prefix = `guild:${guildId}:channel:`;
  const subscriptions: GuildTwitchSubscription[] = [];
  let cursor: string | undefined;

  do {
    const page = await index.list({ prefix, cursor });
    for (const key of page.keys) {
      const subscription = parseGuildTwitchSubscriptionKey(key.name, prefix);
      if (subscription === undefined) {
        logInvalidIndexKey(key.name);
        continue;
      }
      subscriptions.push(subscription);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  return subscriptions;
}

/** Lists the Twitch broadcasters configured for a Discord channel. */
export async function listChannelTwitchSubscriptions(
  index: KVNamespace,
  channelId: string,
): Promise<string[]> {
  requireDiscordSnowflake(channelId, 'Discord channel ID');
  const prefix = `channel:${channelId}:twitch:`;
  const broadcasterIds: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await index.list({ prefix, cursor });
    for (const key of page.keys) {
      const broadcasterId = key.name.slice(prefix.length);
      if (!isTwitchBroadcasterId(broadcasterId)) {
        logInvalidIndexKey(key.name);
        continue;
      }
      broadcasterIds.push(broadcasterId);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  return broadcasterIds;
}

function parseGuildTwitchSubscriptionKey(
  key: string,
  prefix: string,
): GuildTwitchSubscription | undefined {
  if (!key.startsWith(prefix)) return undefined;

  const suffix = key.slice(prefix.length);
  const separator = ':twitch:';
  const separatorOffset = suffix.indexOf(separator);
  if (separatorOffset === -1) return undefined;

  const discordChannelId = suffix.slice(0, separatorOffset);
  const twitchBroadcasterId = suffix.slice(separatorOffset + separator.length);
  if (
    !isDiscordSnowflake(discordChannelId) ||
    !isTwitchBroadcasterId(twitchBroadcasterId)
  ) {
    return undefined;
  }

  return { discordChannelId, twitchBroadcasterId };
}

function isTwitchBroadcasterId(value: string): boolean {
  return /^\d+$/.test(value);
}

function logInvalidIndexKey(key: string): void {
  console.warn(
    JSON.stringify({ event: 'twitch_subscription_index_key_invalid', key }),
  );
}
