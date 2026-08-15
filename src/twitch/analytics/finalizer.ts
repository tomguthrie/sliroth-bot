import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import {
  activityEvents,
  audienceSamples,
  chatMessages,
  streamCategoryRollups,
  streamMetadataChanges,
  streamMinuteRollups,
  streamSegments,
  streamSummaries,
  streams,
} from '../../db/twitch-analytics/schema';

const MINUTE_MS = 60 * 1000;
const VIEWER_SAMPLE_VALIDITY_MS = 2 * MINUTE_MS;
const INSERT_CHUNK_SIZE = 250;
const ALGORITHM = 'step-viewers-120s-v1';

type Stream = typeof streams.$inferSelect;
type MetadataChange = typeof streamMetadataChanges.$inferSelect;
type AudienceSample = typeof audienceSamples.$inferSelect;
type ChatMessage = typeof chatMessages.$inferSelect;
type ActivityEvent = typeof activityEvents.$inferSelect;
type Segment = typeof streamSegments.$inferInsert;
type MinuteRollup = typeof streamMinuteRollups.$inferInsert;
type CategoryRollup = typeof streamCategoryRollups.$inferInsert;

interface MinuteAccumulator {
  coveredSeconds: number;
  viewerSeconds: number;
  peakViewers: number | null;
  chatMessages: number;
  chatterIds: Set<string>;
  bits: number;
  channelPoints: number;
  follows: number;
  subscriptions: number;
  activityEvents: number;
}

/** Builds stable, query-friendly analytics from one completed stream. */
export class TwitchAnalyticsFinalizer {
  private readonly db;

  constructor(private readonly env: Env) {
    this.db = drizzle(env.TWITCH_ANALYTICS_DB);
  }

  async finalize(streamId: string, computedAt: Date): Promise<boolean> {
    const [stream] = await this.db
      .select()
      .from(streams)
      .where(
        and(
          eq(streams.streamId, streamId),
          eq(streams.channelId, this.env.TWITCH_ANALYTICS_CHANNEL_ID),
        ),
      )
      .limit(1);
    if (stream?.endedAt == null) return false;
    const completedStream: Stream & { endedAt: Date } = {
      ...stream,
      endedAt: stream.endedAt,
    };

    const [metadata, audience, chat, activity] = await Promise.all([
      this.db
        .select()
        .from(streamMetadataChanges)
        .where(eq(streamMetadataChanges.streamId, streamId))
        .orderBy(
          asc(streamMetadataChanges.occurredAt),
          asc(streamMetadataChanges.recordedAt),
        ),
      this.db
        .select()
        .from(audienceSamples)
        .where(eq(audienceSamples.streamId, streamId))
        .orderBy(asc(audienceSamples.sampledAt)),
      this.db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.streamId, streamId))
        .orderBy(asc(chatMessages.sentAt)),
      this.db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.streamId, streamId))
        .orderBy(asc(activityEvents.occurredAt)),
    ]);

    const fallbackMetadata =
      metadata.length === 0
        ? await this.latestChannelMetadata(completedStream)
        : undefined;
    const segments = buildSegments(completedStream, metadata, fallbackMetadata);
    const minutes = buildMinuteRollups(
      completedStream,
      audience,
      chat,
      activity,
    );
    const categories = buildCategoryRollups(streamId, segments);
    const summary = buildSummary(
      completedStream,
      segments,
      minutes,
      audience,
      chat,
      activity,
      categories,
      computedAt,
    );

    await this.db
      .delete(streamMinuteRollups)
      .where(eq(streamMinuteRollups.streamId, streamId));
    await this.db
      .delete(streamCategoryRollups)
      .where(eq(streamCategoryRollups.streamId, streamId));
    await this.db
      .delete(streamSegments)
      .where(eq(streamSegments.streamId, streamId));
    await insertSegmentChunks(this.db, segments);
    await insertMinuteChunks(this.db, minutes);
    await insertCategoryChunks(this.db, categories);
    await this.db.insert(streamSummaries).values(summary).onConflictDoUpdate({
      target: streamSummaries.streamId,
      set: summary,
    });
    await this.db
      .update(streams)
      .set({
        status: 'finalized',
        dirty: false,
        finalizedAt: computedAt,
        summaryRevision: summary.revision,
      })
      .where(eq(streams.streamId, streamId));
    return true;
  }

  private async latestChannelMetadata(
    stream: Stream & { endedAt: Date },
  ): Promise<MetadataChange | undefined> {
    const [metadata] = await this.db
      .select()
      .from(streamMetadataChanges)
      .where(
        and(
          eq(streamMetadataChanges.channelId, stream.channelId),
          lte(streamMetadataChanges.occurredAt, stream.endedAt),
        ),
      )
      .orderBy(desc(streamMetadataChanges.occurredAt))
      .limit(1);
    return metadata;
  }
}

function buildSegments(
  stream: Stream & { endedAt: Date },
  metadata: readonly MetadataChange[],
  fallback: MetadataChange | undefined,
): Segment[] {
  const changes =
    metadata.length === 0 ? (fallback ? [fallback] : []) : metadata;
  const first = changes[0];
  let current = metadataValues(first);
  let segmentStartedAt = stream.startedAt;
  const segments: Segment[] = [];

  for (const change of changes.slice(1)) {
    const changedAt = clampDate(
      change.occurredAt,
      stream.startedAt,
      stream.endedAt,
    );
    const next = metadataValues(change);
    if (sameMetadata(current, next)) continue;
    if (changedAt > segmentStartedAt) {
      segments.push({
        streamId: stream.streamId,
        startedAt: segmentStartedAt,
        endedAt: changedAt,
        ...current,
      });
    }
    current = next;
    segmentStartedAt = changedAt;
  }

  if (stream.endedAt > segmentStartedAt) {
    segments.push({
      streamId: stream.streamId,
      startedAt: segmentStartedAt,
      endedAt: stream.endedAt,
      ...current,
    });
  }
  return segments;
}

function metadataValues(change: MetadataChange | undefined) {
  return {
    title: change?.title ?? 'Untitled stream',
    categoryId: change?.categoryId ?? null,
    categoryName: change?.categoryName ?? 'Uncategorized',
    language: change?.language ?? null,
  };
}

function sameMetadata(
  left: ReturnType<typeof metadataValues>,
  right: ReturnType<typeof metadataValues>,
): boolean {
  return (
    left.title === right.title &&
    left.categoryId === right.categoryId &&
    left.categoryName === right.categoryName &&
    left.language === right.language
  );
}

function buildMinuteRollups(
  stream: Stream & { endedAt: Date },
  audience: readonly AudienceSample[],
  chat: readonly ChatMessage[],
  activity: readonly ActivityEvent[],
): MinuteRollup[] {
  const buckets = new Map<number, MinuteAccumulator>();
  const startMs = stream.startedAt.getTime();
  const endMs = stream.endedAt.getTime();
  for (
    let minuteMs = floorMinute(startMs);
    minuteMs < endMs;
    minuteMs += MINUTE_MS
  ) {
    buckets.set(minuteMs, emptyMinute());
  }

  const viewerSamples = audience.filter(
    (sample) => sample.viewerCount !== null,
  );
  for (const [index, sample] of viewerSamples.entries()) {
    if (sample.viewerCount === null) continue;
    const sampleMs = Math.max(startMs, sample.sampledAt.getTime());
    const nextSample = viewerSamples[index + 1];
    const coveredUntil = Math.min(
      endMs,
      sampleMs + VIEWER_SAMPLE_VALIDITY_MS,
      nextSample?.sampledAt.getTime() ?? endMs,
    );
    addViewerInterval(buckets, sampleMs, coveredUntil, sample.viewerCount);
  }

  for (const message of chat) {
    const bucket = buckets.get(floorMinute(message.sentAt.getTime()));
    if (bucket === undefined) continue;
    bucket.chatMessages += 1;
    bucket.chatterIds.add(message.chatterUserId);
  }

  for (const event of activity) {
    const bucket = buckets.get(floorMinute(event.occurredAt.getTime()));
    if (bucket === undefined) continue;
    bucket.activityEvents += 1;
    switch (event.kind) {
      case 'cheer':
        bucket.bits += event.value ?? 0;
        break;
      case 'channel_points_redemption':
        bucket.channelPoints += event.value ?? 0;
        break;
      case 'follow':
        bucket.follows += 1;
        break;
      case 'subscription':
        bucket.subscriptions += event.quantity ?? 1;
        break;
    }
  }

  return [...buckets.entries()].map(([minuteMs, bucket]) => ({
    streamId: stream.streamId,
    minuteAt: new Date(minuteMs),
    coveredSeconds: Math.round(bucket.coveredSeconds),
    viewerSeconds: Math.round(bucket.viewerSeconds),
    peakViewers: bucket.peakViewers,
    chatMessages: bucket.chatMessages,
    uniqueChatters: bucket.chatterIds.size,
    bits: bucket.bits,
    channelPoints: bucket.channelPoints,
    follows: bucket.follows,
    subscriptions: bucket.subscriptions,
    activityEvents: bucket.activityEvents,
  }));
}

function emptyMinute(): MinuteAccumulator {
  return {
    coveredSeconds: 0,
    viewerSeconds: 0,
    peakViewers: null,
    chatMessages: 0,
    chatterIds: new Set(),
    bits: 0,
    channelPoints: 0,
    follows: 0,
    subscriptions: 0,
    activityEvents: 0,
  };
}

function addViewerInterval(
  buckets: Map<number, MinuteAccumulator>,
  startedAt: number,
  endedAt: number,
  viewers: number,
): void {
  let cursor = startedAt;
  while (cursor < endedAt) {
    const minuteMs = floorMinute(cursor);
    const intervalEnd = Math.min(endedAt, minuteMs + MINUTE_MS);
    const seconds = (intervalEnd - cursor) / 1000;
    const bucket = buckets.get(minuteMs);
    if (bucket !== undefined) {
      bucket.coveredSeconds += seconds;
      bucket.viewerSeconds += viewers * seconds;
      bucket.peakViewers = Math.max(bucket.peakViewers ?? 0, viewers);
    }
    cursor = intervalEnd;
  }
}

function buildCategoryRollups(
  streamId: string,
  segments: readonly Segment[],
): CategoryRollup[] {
  const categories = new Map<
    string,
    Omit<CategoryRollup, 'streamId' | 'durationSeconds'> & {
      durationSeconds: number;
    }
  >();
  for (const segment of segments) {
    if (segment.endedAt === null || segment.endedAt === undefined) continue;
    const key = categoryKey(segment.categoryId, segment.categoryName);
    const current = categories.get(key);
    const durationSeconds = Math.max(
      0,
      Math.round(
        (segment.endedAt.getTime() - segment.startedAt.getTime()) / 1000,
      ),
    );
    categories.set(key, {
      categoryKey: key,
      categoryId: segment.categoryId ?? null,
      categoryName: segment.categoryName ?? 'Uncategorized',
      durationSeconds: (current?.durationSeconds ?? 0) + durationSeconds,
    });
  }
  return [...categories.values()].map((category) => ({
    streamId,
    ...category,
  }));
}

function buildSummary(
  stream: Stream & { endedAt: Date },
  segments: readonly Segment[],
  minutes: readonly MinuteRollup[],
  audience: readonly AudienceSample[],
  chat: readonly ChatMessage[],
  activity: readonly ActivityEvent[],
  categories: readonly CategoryRollup[],
  computedAt: Date,
): typeof streamSummaries.$inferInsert {
  const followers = audience.flatMap((sample) =>
    sample.followerCount === null ? [] : [sample.followerCount],
  );
  const subscribers = audience.flatMap((sample) =>
    sample.subscriberCount === null ? [] : [sample.subscriberCount],
  );
  const primaryCategory = [...categories].sort(
    (left, right) => right.durationSeconds - left.durationSeconds,
  )[0];
  const lastSegment = segments[segments.length - 1];

  return {
    streamId: stream.streamId,
    revision: stream.summaryRevision + 1,
    algorithm: ALGORITHM,
    computedAt,
    durationSeconds: Math.max(
      0,
      Math.round(
        (stream.endedAt.getTime() - stream.startedAt.getTime()) / 1000,
      ),
    ),
    viewerSeconds: sum(minutes, (minute) => minute.viewerSeconds),
    viewerCoveredSeconds: sum(minutes, (minute) => minute.coveredSeconds),
    peakViewers: maximum(
      minutes.flatMap((minute) =>
        minute.peakViewers === null || minute.peakViewers === undefined
          ? []
          : [minute.peakViewers],
      ),
    ),
    followerCountFirst: followers[0] ?? null,
    followerCountLast: followers[followers.length - 1] ?? null,
    subscriberCountFirst: subscribers[0] ?? null,
    subscriberCountLast: subscribers[subscribers.length - 1] ?? null,
    chatMessages: chat.length,
    uniqueChatters: new Set(chat.map((message) => message.chatterUserId)).size,
    bits: sum(minutes, (minute) => minute.bits ?? 0),
    channelPoints: sum(minutes, (minute) => minute.channelPoints ?? 0),
    follows: sum(minutes, (minute) => minute.follows ?? 0),
    subscriptions: sum(minutes, (minute) => minute.subscriptions ?? 0),
    raidsIn: activity.filter((event) => event.kind === 'raid_in').length,
    raidsOut: activity.filter((event) => event.kind === 'raid_out').length,
    displayTitle: lastSegment?.title ?? 'Untitled stream',
    primaryCategoryId: primaryCategory?.categoryId ?? null,
    primaryCategoryName: primaryCategory?.categoryName ?? 'Uncategorized',
  };
}

async function insertSegmentChunks(
  db: ReturnType<typeof drizzle>,
  values: readonly Segment[],
): Promise<void> {
  for (let index = 0; index < values.length; index += INSERT_CHUNK_SIZE) {
    const chunk = values.slice(index, index + INSERT_CHUNK_SIZE);
    if (chunk.length > 0) await db.insert(streamSegments).values(chunk);
  }
}

async function insertMinuteChunks(
  db: ReturnType<typeof drizzle>,
  values: readonly MinuteRollup[],
): Promise<void> {
  for (let index = 0; index < values.length; index += INSERT_CHUNK_SIZE) {
    const chunk = values.slice(index, index + INSERT_CHUNK_SIZE);
    if (chunk.length > 0) await db.insert(streamMinuteRollups).values(chunk);
  }
}

async function insertCategoryChunks(
  db: ReturnType<typeof drizzle>,
  values: readonly CategoryRollup[],
): Promise<void> {
  for (let index = 0; index < values.length; index += INSERT_CHUNK_SIZE) {
    const chunk = values.slice(index, index + INSERT_CHUNK_SIZE);
    if (chunk.length > 0) await db.insert(streamCategoryRollups).values(chunk);
  }
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function maximum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function floorMinute(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}

function clampDate(value: Date, minimum: Date, maximum: Date): Date {
  return new Date(
    Math.max(minimum.getTime(), Math.min(maximum.getTime(), value.getTime())),
  );
}

function categoryKey(
  id: string | null | undefined,
  name: string | null | undefined,
): string {
  return id === null || id === undefined
    ? `name:${(name ?? 'Uncategorized').toLocaleLowerCase()}`
    : `id:${id}`;
}
