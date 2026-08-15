import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import type { DiscordMentionTarget } from '../../discord';

export const broadcasters = snakeCase.table(
  'broadcaster',
  {
    id: text().notNull(),
    login: text().notNull(),
    displayName: text().notNull(),
    profileImageUrl: text().notNull(),
    offlineImageUrl: text().notNull(),
    eventSubAuditedAt: integer({ mode: 'timestamp_ms' }),
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
    ping: text().$type<DiscordMentionTarget>(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId] }),
    index('subscribers_guild_id_idx').on(table.guildId),
  ],
);

export const eventSubSubscriptions = snakeCase.table(
  'eventsub_subscriptions',
  {
    subscriptionKey: text().notNull(),
    type: text().notNull(),
    version: text().notNull(),
    conditionJson: text().notNull(),
    subscriptionId: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subscriptionKey] }),
    index('eventsub_subscriptions_type_idx').on(table.type),
    uniqueIndex('eventsub_subscriptions_subscription_id_idx').on(
      table.subscriptionId,
    ),
    check(
      'eventsub_subscriptions_condition_json_check',
      sql`json_valid(${table.conditionJson})`,
    ),
  ],
);

export const analyticsAuthorization = snakeCase.table(
  'analytics_authorization',
  {
    singleton: integer().notNull(),
    accessToken: text().notNull(),
    refreshToken: text().notNull(),
    scopesJson: text().notNull(),
    authorizedAt: integer({ mode: 'timestamp_ms' }).notNull(),
    validatedAt: integer({ mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.singleton] }),
    check(
      'analytics_authorization_singleton_check',
      sql`${table.singleton} = 1`,
    ),
    check(
      'analytics_authorization_scopes_json_check',
      sql`json_valid(${table.scopesJson})`,
    ),
  ],
);

export const analyticsRuntime = snakeCase.table(
  'analytics_runtime',
  {
    singleton: integer().notNull(),
    status: text()
      .$type<'inactive' | 'active' | 'reauthorization_required'>()
      .notNull(),
    enabledAt: integer({ mode: 'timestamp_ms' }).notNull(),
    activeStreamId: text(),
    offlineSuspectedAt: integer({ mode: 'timestamp_ms' }),
    consecutiveStreamMisses: integer().notNull().default(0),
    nextViewerSampleAt: integer({ mode: 'timestamp_ms' }),
    nextAudienceSampleAt: integer({ mode: 'timestamp_ms' }),
    nextTokenValidationAt: integer({ mode: 'timestamp_ms' }),
    nextEventSubAuditAt: integer({ mode: 'timestamp_ms' }),
  },
  (table) => [
    primaryKey({ columns: [table.singleton] }),
    check('analytics_runtime_singleton_check', sql`${table.singleton} = 1`),
    check(
      'analytics_runtime_status_check',
      sql`${table.status} in ('inactive', 'active', 'reauthorization_required')`,
    ),
  ],
);

export const analyticsOauthStates = snakeCase.table(
  'analytics_oauth_states',
  {
    stateHash: text().notNull(),
    createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.stateHash] }),
    index('analytics_oauth_states_expires_at_idx').on(table.expiresAt),
  ],
);

export const analyticsPendingFinalizers = snakeCase.table(
  'analytics_pending_finalizers',
  {
    streamId: text().notNull(),
    finalizeAfter: integer({ mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.streamId] }),
    index('analytics_pending_finalizers_due_idx').on(table.finalizeAfter),
  ],
);

export const processedEventSubMessages = snakeCase.table(
  'processed_eventsub_messages',
  {
    messageId: text().notNull(),
    processedAt: integer({ mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId] }),
    index('processed_eventsub_messages_processed_at_idx').on(table.processedAt),
  ],
);

export const streams = snakeCase.table(
  'streams',
  {
    id: text().notNull(),
    title: text().notNull(),
    gameName: text().notNull(),
    viewerCount: integer().notNull(),
    gameBoxArtUrl: text(),
    previewImageUrl: text().notNull(),
    startedAt: integer({ mode: 'timestamp_ms' }).notNull(),
    endedAt: integer({ mode: 'timestamp_ms' }),
    vodUrl: text(),
    revision: integer().notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const streamMessages = snakeCase.table(
  'stream_messages',
  {
    streamId: text().notNull(),
    channelId: text().notNull(),
    messageId: text(),
    enqueuedRevision: integer().notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.streamId, table.channelId] })],
);
