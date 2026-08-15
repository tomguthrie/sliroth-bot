import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  snakeCase,
  text,
} from 'drizzle-orm/sqlite-core';

import type { DiscordMentionTarget } from '../../discord';

const currentTimestampMs = () =>
  sql`(cast(unixepoch('subsec') * 1000 as integer))`;

export const videos = snakeCase.table(
  'videos',
  {
    id: text().notNull(),
    title: text().notNull(),
    publishedAt: integer({ mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const subscribers = snakeCase.table(
  'subscribers',
  {
    channelId: text().notNull(),
    guildId: text().notNull(),
    message: text(),
    ping: text().$type<DiscordMentionTarget>(),
    createdAt: integer({ mode: 'timestamp_ms' })
      .notNull()
      .default(currentTimestampMs()),
    updatedAt: integer({ mode: 'timestamp_ms' })
      .notNull()
      .default(currentTimestampMs())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.channelId] }),
    index('subscribers_guild_id_idx').on(table.guildId),
  ],
);
