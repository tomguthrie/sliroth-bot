import {
  index,
  primaryKey,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import type { DiscordSnowflake } from '../../discord/snowflake';

export type TwitchSubscriberPing = 'everyone' | 'here' | DiscordSnowflake;

export const broadcasters = snakeCase.table(
  'broadcaster',
  {
    id: text().notNull(),
    login: text().notNull(),
    displayName: text().notNull(),
    profileImageUrl: text().notNull(),
    offlineImageUrl: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const twitchSubscribers = snakeCase.table(
  'subscribers',
  {
    channelId: text().notNull(),
    guildId: text().notNull(),
    message: text(),
    offline: text(),
    ping: text().$type<TwitchSubscriberPing>(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId] }),
    index('subscribers_guild_id_idx').on(table.guildId),
  ],
);

export const eventSubSubscriptions = snakeCase.table(
  'eventsub_subscriptions',
  {
    type: text().notNull(),
    subscriptionId: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.type] }),
    uniqueIndex('eventsub_subscriptions_subscription_id_idx').on(
      table.subscriptionId,
    ),
  ],
);
