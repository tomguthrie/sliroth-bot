import type * as z from 'zod';

import { DiscordSnowflake } from './discord/snowflake';

const INDEX_VALUE = '1';

/** Identifies one provider subscription posted to a Discord channel. */
export interface SubscriptionLookupEntry {
  guildId: string;
  channelId: string;
  providerId: string;
}

/** A guild-indexed subscription and the display metadata stored with it. */
export interface GuildSubscription<Metadata> {
  channelId: DiscordSnowflake;
  providerId: string;
  metadata: Metadata;
}

/** KV lookups from Discord guilds and channels to one provider's subscriptions. */
export interface SubscriptionLookup<Metadata> {
  /** Indexes a subscription by guild, with its display metadata, and by channel. */
  add(index: KVNamespace, entry: SubscriptionLookupEntry, metadata: Metadata): Promise<void>;
  /** Removes both index entries for a subscription. */
  remove(index: KVNamespace, entry: SubscriptionLookupEntry): Promise<void>;
  /** Lists a guild's subscriptions, logging and skipping malformed entries. */
  listGuild(index: KVNamespace, guildId: string): Promise<GuildSubscription<Metadata>[]>;
  /** Lists the provider IDs subscribed in a Discord channel, logging and skipping malformed entries. */
  listChannel(index: KVNamespace, channelId: string): Promise<string[]>;
}

/**
 * Creates the KV subscription lookup for one provider.
 *
 * Keys are `guild:<guildId>:channel:<channelId>:<provider>:<providerId>` and
 * `channel:<channelId>:<provider>:<providerId>`; changing either format orphans
 * existing entries.
 */
export function createSubscriptionLookup<Metadata>(
  provider: string,
  isProviderId: (value: string) => boolean,
  MetadataSchema: z.ZodType<Metadata>,
): SubscriptionLookup<Metadata> {
  const guildKey = ({ guildId, channelId, providerId }: SubscriptionLookupEntry) =>
    `guild:${guildId}:channel:${channelId}:${provider}:${providerId}`;
  const channelKey = ({ channelId, providerId }: SubscriptionLookupEntry) =>
    `channel:${channelId}:${provider}:${providerId}`;
  const logInvalidKey = (key: string) => {
    console.warn({ event: `${provider}_subscription_index_key_invalid`, key });
  };

  return {
    async add(index, entry, metadata) {
      await Promise.all([
        index.put(guildKey(entry), INDEX_VALUE, { metadata }),
        index.put(channelKey(entry), INDEX_VALUE),
      ]);
    },

    async remove(index, entry) {
      await Promise.all([index.delete(guildKey(entry)), index.delete(channelKey(entry))]);
    },

    async listGuild(index, guildId) {
      DiscordSnowflake.parse(guildId);
      const prefix = `guild:${guildId}:channel:`;
      const separator = `:${provider}:`;
      const page = await index.list({ prefix });

      return page.keys.flatMap((key) => {
        const suffix = key.name.slice(prefix.length);
        const separatorOffset = suffix.indexOf(separator);
        const channelId = DiscordSnowflake.safeParse(suffix.slice(0, separatorOffset));
        const providerId = suffix.slice(separatorOffset + separator.length);
        const metadata = MetadataSchema.safeParse(key.metadata);
        if (
          separatorOffset === -1 ||
          !channelId.success ||
          !isProviderId(providerId) ||
          !metadata.success
        ) {
          logInvalidKey(key.name);
          return [];
        }
        return [{ channelId: channelId.data, providerId, metadata: metadata.data }];
      });
    },

    async listChannel(index, channelId) {
      DiscordSnowflake.parse(channelId);
      const prefix = `channel:${channelId}:${provider}:`;
      const page = await index.list({ prefix });

      return page.keys.flatMap((key) => {
        const providerId = key.name.slice(prefix.length);
        if (!isProviderId(providerId)) {
          logInvalidKey(key.name);
          return [];
        }
        return [providerId];
      });
    },
  };
}
