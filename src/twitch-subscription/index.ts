import * as z from 'zod';

import { DiscordSnowflake } from '../discord/snowflake';
import { TwitchBroadcasterId } from '../twitch/data';

const NonBlankString = z.string().refine((value) => value.trim() !== '');

export const TwitchSubscriptionMetadata = z.object({
  login: NonBlankString,
  displayName: NonBlankString,
});

export type TwitchSubscriptionMetadata = z.infer<
  typeof TwitchSubscriptionMetadata
>;

export interface GuildTwitchSubscription {
  discordChannelId: string;
  twitchBroadcasterId: TwitchBroadcasterId;
  twitchBroadcasterLogin: string;
  twitchBroadcasterDisplayName: string;
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
  DiscordSnowflake.parse(guildId);
  const prefix = `guild:${guildId}:channel:`;
  const page = await index.list<TwitchSubscriptionMetadata>({ prefix });

  return page.keys.flatMap((key) => {
    const subscription = parseGuildTwitchSubscriptionKey(
      key.name,
      prefix,
      key.metadata,
    );
    if (subscription === undefined) {
      logInvalidIndexKey(key.name);
      return [];
    }
    return [subscription];
  });
}

/** Lists the Twitch broadcasters configured for a Discord channel. */
export async function listChannelTwitchSubscriptions(
  index: KVNamespace,
  channelId: string,
): Promise<TwitchBroadcasterId[]> {
  DiscordSnowflake.parse(channelId);
  const prefix = `channel:${channelId}:twitch:`;
  const page = await index.list({ prefix });

  return page.keys.flatMap((key) => {
    const broadcasterId = key.name.slice(prefix.length);
    const result = TwitchBroadcasterId.safeParse(broadcasterId);
    if (!result.success) {
      logInvalidIndexKey(key.name);
      return [];
    }
    return [result.data];
  });
}

function parseGuildTwitchSubscriptionKey(
  key: string,
  prefix: string,
  metadata: unknown,
): GuildTwitchSubscription | undefined {
  if (!key.startsWith(prefix)) return undefined;

  const suffix = key.slice(prefix.length);
  const separator = ':twitch:';
  const separatorOffset = suffix.indexOf(separator);
  if (separatorOffset === -1) return undefined;

  const discordChannelId = suffix.slice(0, separatorOffset);
  const twitchBroadcasterId = suffix.slice(separatorOffset + separator.length);
  const parsedBroadcasterId =
    TwitchBroadcasterId.safeParse(twitchBroadcasterId);
  const parsedMetadata = TwitchSubscriptionMetadata.safeParse(metadata);
  if (
    !DiscordSnowflake.safeParse(discordChannelId).success ||
    !parsedBroadcasterId.success ||
    !parsedMetadata.success
  ) {
    return undefined;
  }

  return {
    discordChannelId,
    twitchBroadcasterId: parsedBroadcasterId.data,
    twitchBroadcasterLogin: parsedMetadata.data.login,
    twitchBroadcasterDisplayName: parsedMetadata.data.displayName,
  };
}

function logInvalidIndexKey(key: string): void {
  console.warn({ event: 'twitch_subscription_index_key_invalid', key });
}
