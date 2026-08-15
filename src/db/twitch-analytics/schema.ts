import { sql, type SQLWrapper } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const timestamp = () => integer({ mode: 'timestamp_ms' });
const nonNegative = (column: SQLWrapper) => sql`${column} >= 0`;

export const analyticsChannels = snakeCase.table(
  'analytics_channels',
  {
    channelId: text().notNull(),
    login: text().notNull(),
    displayName: text().notNull(),
    timezone: text().notNull().default('Europe/London'),
    trackingStartedAt: timestamp().notNull(),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelId] })],
);

export const analyticsCapabilities = snakeCase.table(
  'analytics_capabilities',
  {
    channelId: text()
      .notNull()
      .references(() => analyticsChannels.channelId, { onDelete: 'restrict' }),
    capability: text().notNull(),
    status: text()
      .$type<'active' | 'unavailable' | 'revoked' | 'error'>()
      .notNull(),
    reason: text(),
    checkedAt: timestamp().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.capability] }),
    check(
      'analytics_capabilities_status_check',
      sql`${table.status} in ('active', 'unavailable', 'revoked', 'error')`,
    ),
  ],
);

export const streams = snakeCase.table(
  'streams',
  {
    streamId: text().notNull(),
    channelId: text()
      .notNull()
      .references(() => analyticsChannels.channelId, { onDelete: 'restrict' }),
    startedAt: timestamp().notNull(),
    startedRecordedAt: timestamp().notNull(),
    endedAt: timestamp(),
    endedRecordedAt: timestamp(),
    status: text().$type<'live' | 'finalizing' | 'finalized'>().notNull(),
    dirty: integer({ mode: 'boolean' }).notNull().default(true),
    finalizedAt: timestamp(),
    summaryRevision: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.streamId] }),
    index('streams_channel_started_at_idx').on(
      table.channelId,
      table.startedAt,
    ),
    index('streams_channel_status_idx').on(table.channelId, table.status),
    check(
      'streams_status_check',
      sql`${table.status} in ('live', 'finalizing', 'finalized')`,
    ),
    check(
      'streams_ended_at_check',
      sql`${table.endedAt} is null or ${table.endedAt} >= ${table.startedAt}`,
    ),
    check('streams_summary_revision_check', nonNegative(table.summaryRevision)),
  ],
);

export const streamMetadataChanges = snakeCase.table(
  'stream_metadata_changes',
  {
    changeId: text().notNull(),
    channelId: text()
      .notNull()
      .references(() => analyticsChannels.channelId, { onDelete: 'restrict' }),
    streamId: text().references(() => streams.streamId, {
      onDelete: 'restrict',
    }),
    occurredAt: timestamp().notNull(),
    recordedAt: timestamp().notNull(),
    title: text().notNull(),
    categoryId: text(),
    categoryName: text(),
    language: text(),
    contentLabelsJson: text().notNull().default('[]'),
  },
  (table) => [
    primaryKey({ columns: [table.changeId] }),
    index('stream_metadata_changes_stream_occurred_at_idx').on(
      table.streamId,
      table.occurredAt,
    ),
    check(
      'stream_metadata_changes_content_labels_json_check',
      sql`json_valid(${table.contentLabelsJson})`,
    ),
  ],
);

export const audienceSamples = snakeCase.table(
  'audience_samples',
  {
    sampleId: integer().primaryKey({ autoIncrement: true }),
    channelId: text()
      .notNull()
      .references(() => analyticsChannels.channelId, { onDelete: 'restrict' }),
    streamId: text().references(() => streams.streamId, {
      onDelete: 'restrict',
    }),
    sampledAt: timestamp().notNull(),
    viewerCount: integer(),
    followerCount: integer(),
    subscriberCount: integer(),
    source: text()
      .$type<'activation' | 'stream_start' | 'alarm' | 'stream_end'>()
      .notNull(),
  },
  (table) => [
    uniqueIndex('audience_samples_channel_sampled_at_idx').on(
      table.channelId,
      table.sampledAt,
    ),
    index('audience_samples_stream_sampled_at_idx').on(
      table.streamId,
      table.sampledAt,
    ),
    check(
      'audience_samples_source_check',
      sql`${table.source} in ('activation', 'stream_start', 'alarm', 'stream_end')`,
    ),
    check(
      'audience_samples_has_value_check',
      sql`${table.viewerCount} is not null or ${table.followerCount} is not null or ${table.subscriberCount} is not null`,
    ),
    check(
      'audience_samples_viewer_count_check',
      sql`${table.viewerCount} is null or ${table.viewerCount} >= 0`,
    ),
    check(
      'audience_samples_follower_count_check',
      sql`${table.followerCount} is null or ${table.followerCount} >= 0`,
    ),
    check(
      'audience_samples_subscriber_count_check',
      sql`${table.subscriberCount} is null or ${table.subscriberCount} >= 0`,
    ),
  ],
);

export const chatMessages = snakeCase.table(
  'chat_messages',
  {
    eventSubMessageId: text().notNull(),
    twitchMessageId: text().notNull(),
    channelId: text()
      .notNull()
      .references(() => analyticsChannels.channelId, { onDelete: 'restrict' }),
    streamId: text().references(() => streams.streamId, {
      onDelete: 'restrict',
    }),
    sentAt: timestamp().notNull(),
    receivedAt: timestamp().notNull(),
    chatterUserId: text().notNull(),
    chatterLogin: text().notNull(),
    chatterName: text().notNull(),
    messageType: text().notNull(),
    sourceBroadcasterUserId: text(),
  },
  (table) => [
    primaryKey({ columns: [table.eventSubMessageId] }),
    uniqueIndex('chat_messages_twitch_message_id_idx').on(
      table.twitchMessageId,
    ),
    index('chat_messages_stream_sent_at_idx').on(table.streamId, table.sentAt),
    index('chat_messages_stream_chatter_idx').on(
      table.streamId,
      table.chatterUserId,
    ),
  ],
);

export const activityEvents = snakeCase.table(
  'activity_events',
  {
    eventSubMessageId: text().notNull(),
    providerEventId: text(),
    channelId: text()
      .notNull()
      .references(() => analyticsChannels.channelId, { onDelete: 'restrict' }),
    streamId: text().references(() => streams.streamId, {
      onDelete: 'restrict',
    }),
    kind: text().notNull(),
    occurredAt: timestamp().notNull(),
    receivedAt: timestamp().notNull(),
    actorUserId: text(),
    actorLogin: text(),
    actorName: text(),
    targetUserId: text(),
    targetLogin: text(),
    targetName: text(),
    quantity: integer(),
    value: integer(),
    unit: text(),
    schemaVersion: integer().notNull().default(1),
    detailsJson: text().notNull().default('{}'),
  },
  (table) => [
    primaryKey({ columns: [table.eventSubMessageId] }),
    index('activity_events_stream_occurred_at_idx').on(
      table.streamId,
      table.occurredAt,
    ),
    index('activity_events_stream_kind_idx').on(table.streamId, table.kind),
    check(
      'activity_events_quantity_check',
      sql`${table.quantity} is null or ${table.quantity} >= 0`,
    ),
    check(
      'activity_events_schema_version_check',
      sql`${table.schemaVersion} > 0`,
    ),
    check(
      'activity_events_details_json_check',
      sql`json_valid(${table.detailsJson})`,
    ),
  ],
);

export const streamSegments = snakeCase.table(
  'stream_segments',
  {
    streamId: text()
      .notNull()
      .references(() => streams.streamId, { onDelete: 'restrict' }),
    startedAt: timestamp().notNull(),
    endedAt: timestamp(),
    title: text().notNull(),
    categoryId: text(),
    categoryName: text(),
    language: text(),
  },
  (table) => [
    primaryKey({ columns: [table.streamId, table.startedAt] }),
    check(
      'stream_segments_ended_at_check',
      sql`${table.endedAt} is null or ${table.endedAt} > ${table.startedAt}`,
    ),
  ],
);

export const streamMinuteRollups = snakeCase.table(
  'stream_minute_rollups',
  {
    streamId: text()
      .notNull()
      .references(() => streams.streamId, { onDelete: 'restrict' }),
    minuteAt: timestamp().notNull(),
    coveredSeconds: integer().notNull(),
    viewerSeconds: integer().notNull(),
    peakViewers: integer(),
    chatMessages: integer().notNull().default(0),
    uniqueChatters: integer().notNull().default(0),
    bits: integer().notNull().default(0),
    channelPoints: integer().notNull().default(0),
    follows: integer().notNull().default(0),
    subscriptions: integer().notNull().default(0),
    activityEvents: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.streamId, table.minuteAt] }),
    check(
      'stream_minute_rollups_covered_seconds_check',
      sql`${table.coveredSeconds} between 0 and 60`,
    ),
    check(
      'stream_minute_rollups_nonnegative_check',
      sql`${table.viewerSeconds} >= 0 and (${table.peakViewers} is null or ${table.peakViewers} >= 0) and ${table.chatMessages} >= 0 and ${table.uniqueChatters} >= 0 and ${table.bits} >= 0 and ${table.channelPoints} >= 0 and ${table.follows} >= 0 and ${table.subscriptions} >= 0 and ${table.activityEvents} >= 0`,
    ),
  ],
);

export const streamCategoryRollups = snakeCase.table(
  'stream_category_rollups',
  {
    streamId: text()
      .notNull()
      .references(() => streams.streamId, { onDelete: 'restrict' }),
    categoryKey: text().notNull(),
    categoryId: text(),
    categoryName: text().notNull(),
    durationSeconds: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.streamId, table.categoryKey] }),
    check(
      'stream_category_rollups_duration_seconds_check',
      nonNegative(table.durationSeconds),
    ),
  ],
);

export const streamSummaries = snakeCase.table(
  'stream_summaries',
  {
    streamId: text()
      .notNull()
      .references(() => streams.streamId, { onDelete: 'restrict' }),
    revision: integer().notNull(),
    algorithm: text().notNull(),
    computedAt: timestamp().notNull(),
    durationSeconds: integer().notNull(),
    viewerSeconds: integer().notNull(),
    viewerCoveredSeconds: integer().notNull(),
    peakViewers: integer(),
    followerCountFirst: integer(),
    followerCountLast: integer(),
    subscriberCountFirst: integer(),
    subscriberCountLast: integer(),
    chatMessages: integer().notNull().default(0),
    uniqueChatters: integer().notNull().default(0),
    bits: integer().notNull().default(0),
    channelPoints: integer().notNull().default(0),
    follows: integer().notNull().default(0),
    subscriptions: integer().notNull().default(0),
    raidsIn: integer().notNull().default(0),
    raidsOut: integer().notNull().default(0),
    displayTitle: text().notNull(),
    primaryCategoryId: text(),
    primaryCategoryName: text(),
  },
  (table) => [
    primaryKey({ columns: [table.streamId] }),
    check('stream_summaries_revision_check', sql`${table.revision} > 0`),
    check(
      'stream_summaries_nonnegative_check',
      sql`${table.durationSeconds} >= 0 and ${table.viewerSeconds} >= 0 and ${table.viewerCoveredSeconds} >= 0 and (${table.peakViewers} is null or ${table.peakViewers} >= 0) and (${table.followerCountFirst} is null or ${table.followerCountFirst} >= 0) and (${table.followerCountLast} is null or ${table.followerCountLast} >= 0) and (${table.subscriberCountFirst} is null or ${table.subscriberCountFirst} >= 0) and (${table.subscriberCountLast} is null or ${table.subscriberCountLast} >= 0) and ${table.chatMessages} >= 0 and ${table.uniqueChatters} >= 0 and ${table.bits} >= 0 and ${table.channelPoints} >= 0 and ${table.follows} >= 0 and ${table.subscriptions} >= 0 and ${table.raidsIn} >= 0 and ${table.raidsOut} >= 0`,
    ),
  ],
);
