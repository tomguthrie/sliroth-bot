import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import {
  activityEvents,
  analyticsCapabilities,
  analyticsChannels,
  audienceSamples,
  chatMessages,
  streamMetadataChanges,
  streams,
} from '../../db/twitch-analytics/schema';
import type { TwitchStream, TwitchUser } from '../client';
import type { EventSubNotification } from '../eventsub';
import {
  TWITCH_EVENT_CHANNEL_CHAT_MESSAGE,
  TWITCH_EVENT_CHANNEL_CHEER,
  TWITCH_EVENT_CHANNEL_FOLLOW,
  TWITCH_EVENT_CHANNEL_POINTS_REDEMPTION,
  TWITCH_EVENT_CHANNEL_RAID,
  TWITCH_EVENT_CHANNEL_SUBSCRIBE,
  TWITCH_EVENT_CHANNEL_SUBSCRIPTION_GIFT,
  TWITCH_EVENT_CHANNEL_UPDATE,
  TWITCH_EVENT_STREAM_OFFLINE,
  TWITCH_EVENT_STREAM_ONLINE,
} from '../eventsub';
import { TWITCH_ANALYTICS_SCOPES } from './eventsub';

type AudienceSampleSource =
  'activation' | 'stream_start' | 'alarm' | 'stream_end';

interface AudienceSample {
  readonly streamId: string | null;
  readonly sampledAt: Date;
  readonly viewerCount?: number;
  readonly followerCount?: number;
  readonly subscriberCount?: number;
  readonly source: AudienceSampleSource;
}

/** Persists raw Twitch analytics facts to the shared D1 database. */
export class TwitchAnalyticsRepository {
  private readonly db;

  constructor(private readonly env: Env) {
    this.db = drizzle(env.TWITCH_ANALYTICS_DB);
  }

  async initializeChannel(user: TwitchUser, now: Date): Promise<void> {
    await this.db
      .insert(analyticsChannels)
      .values({
        channelId: user.id,
        login: user.login,
        displayName: user.displayName,
        trackingStartedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: analyticsChannels.channelId,
        set: {
          login: user.login,
          displayName: user.displayName,
          updatedAt: now,
        },
      });
  }

  async recordGrantedCapabilities(
    scopes: readonly string[],
    checkedAt: Date,
  ): Promise<void> {
    for (const scope of TWITCH_ANALYTICS_SCOPES) {
      await this.recordCapability(
        `scope:${scope}`,
        scopes.includes(scope) ? 'active' : 'unavailable',
        scopes.includes(scope) ? null : 'OAuth scope was not granted',
        checkedAt,
      );
    }
  }

  async recordCapability(
    capability: string,
    status: 'active' | 'unavailable' | 'revoked' | 'error',
    reason: string | null,
    checkedAt: Date,
  ): Promise<void> {
    await this.db
      .insert(analyticsCapabilities)
      .values({
        channelId: this.env.TWITCH_ANALYTICS_CHANNEL_ID,
        capability,
        status,
        reason,
        checkedAt,
      })
      .onConflictDoUpdate({
        target: [
          analyticsCapabilities.channelId,
          analyticsCapabilities.capability,
        ],
        set: { status, reason, checkedAt },
      });
  }

  async recordAudienceSample(sample: AudienceSample): Promise<void> {
    await this.db
      .insert(audienceSamples)
      .values({
        channelId: this.env.TWITCH_ANALYTICS_CHANNEL_ID,
        ...sample,
      })
      .onConflictDoNothing();
  }

  async recordStreamOnline(
    streamId: string,
    startedAt: Date,
    recordedAt: Date,
  ): Promise<void> {
    await this.db
      .insert(streams)
      .values({
        streamId,
        channelId: this.env.TWITCH_ANALYTICS_CHANNEL_ID,
        startedAt,
        startedRecordedAt: recordedAt,
        status: 'live',
      })
      .onConflictDoUpdate({
        target: streams.streamId,
        set: { status: 'live', endedAt: null, endedRecordedAt: null },
      });
  }

  async finishStream(
    streamId: string,
    endedAt: Date,
    recordedAt: Date = endedAt,
  ): Promise<void> {
    await this.db
      .update(streams)
      .set({
        endedAt,
        endedRecordedAt: recordedAt,
        status: 'finalizing',
        dirty: true,
      })
      .where(eq(streams.streamId, streamId));
  }

  async upsertLiveStream(
    stream: TwitchStream,
    recordedAt: Date,
  ): Promise<void> {
    await this.recordStreamOnline(stream.id, stream.startedAt, recordedAt);
  }

  async recordMetadataIfChanged(
    stream: TwitchStream,
    recordedAt: Date,
  ): Promise<void> {
    const [latest] = await this.db
      .select()
      .from(streamMetadataChanges)
      .where(eq(streamMetadataChanges.streamId, stream.id))
      .orderBy(desc(streamMetadataChanges.occurredAt))
      .limit(1);
    if (
      latest?.title === stream.title &&
      latest.categoryId === stream.gameId &&
      latest.categoryName === stream.gameName
    ) {
      return;
    }
    await this.db.insert(streamMetadataChanges).values({
      changeId: crypto.randomUUID(),
      channelId: this.env.TWITCH_ANALYTICS_CHANNEL_ID,
      streamId: stream.id,
      occurredAt: recordedAt,
      recordedAt,
      title: stream.title,
      categoryId: stream.gameId,
      categoryName: stream.gameName,
    });
  }

  async recordMetadataChange(
    changeId: string,
    streamId: string | null,
    occurredAt: Date,
    event: Extract<
      EventSubNotification,
      { eventType: typeof TWITCH_EVENT_CHANNEL_UPDATE }
    >['event'],
  ): Promise<void> {
    await this.db
      .insert(streamMetadataChanges)
      .values({
        changeId,
        channelId: this.env.TWITCH_ANALYTICS_CHANNEL_ID,
        streamId,
        occurredAt,
        recordedAt: new Date(),
        title: event.title,
        categoryId: event.gameId,
        categoryName: event.gameName,
        language: event.language,
        contentLabelsJson: JSON.stringify(event.contentClassificationLabels),
      })
      .onConflictDoNothing();
  }

  async recordChatMessage(
    eventSubMessageId: string,
    streamId: string | null,
    receivedAt: Date,
    message: Extract<
      EventSubNotification,
      { eventType: typeof TWITCH_EVENT_CHANNEL_CHAT_MESSAGE }
    >,
  ): Promise<void> {
    await this.db
      .insert(chatMessages)
      .values({
        eventSubMessageId,
        twitchMessageId: message.event.messageId,
        channelId: this.env.TWITCH_ANALYTICS_CHANNEL_ID,
        streamId,
        sentAt: receivedAt,
        receivedAt,
        chatterUserId: message.event.chatterUserId,
        chatterLogin: message.event.chatterUserLogin,
        chatterName: message.event.chatterUserName,
        messageType: message.event.messageType,
        sourceBroadcasterUserId: message.event.sourceBroadcasterUserId,
      })
      .onConflictDoNothing();
  }

  async recordActivityEvent(
    eventSubMessageId: string,
    streamId: string | null,
    receivedAt: Date,
    message: AnalyticsActivityNotification,
  ): Promise<void> {
    await this.db
      .insert(activityEvents)
      .values({
        eventSubMessageId,
        channelId: this.env.TWITCH_ANALYTICS_CHANNEL_ID,
        streamId,
        receivedAt,
        ...activityValues(message, receivedAt),
      })
      .onConflictDoNothing();
  }
}

type AnalyticsActivityNotification = Exclude<
  EventSubNotification,
  | { eventType: typeof TWITCH_EVENT_CHANNEL_UPDATE }
  | { eventType: typeof TWITCH_EVENT_STREAM_ONLINE }
  | { eventType: typeof TWITCH_EVENT_STREAM_OFFLINE }
  | { eventType: typeof TWITCH_EVENT_CHANNEL_CHAT_MESSAGE }
>;

function activityValues(
  message: AnalyticsActivityNotification,
  receivedAt: Date,
): Omit<
  typeof activityEvents.$inferInsert,
  'eventSubMessageId' | 'channelId' | 'streamId' | 'receivedAt'
> {
  switch (message.eventType) {
    case TWITCH_EVENT_CHANNEL_FOLLOW:
      return {
        kind: 'follow',
        occurredAt: new Date(message.event.followedAt),
        actorUserId: message.event.userId,
        actorLogin: message.event.userLogin,
        actorName: message.event.userName,
      };
    case TWITCH_EVENT_CHANNEL_SUBSCRIBE:
      return {
        kind: 'subscription',
        occurredAt: receivedAt,
        actorUserId: message.event.userId,
        actorLogin: message.event.userLogin,
        actorName: message.event.userName,
        quantity: 1,
        unit: message.event.tier,
        detailsJson: JSON.stringify({ isGift: message.event.isGift }),
      };
    case TWITCH_EVENT_CHANNEL_SUBSCRIPTION_GIFT:
      return {
        kind: 'subscription_gift',
        occurredAt: receivedAt,
        actorUserId: message.event.userId,
        actorLogin: message.event.userLogin,
        actorName: message.event.userName,
        quantity: message.event.total,
        unit: message.event.tier,
        detailsJson: JSON.stringify({ isAnonymous: message.event.isAnonymous }),
      };
    case TWITCH_EVENT_CHANNEL_CHEER:
      return {
        kind: 'cheer',
        occurredAt: receivedAt,
        actorUserId: message.event.userId,
        actorLogin: message.event.userLogin,
        actorName: message.event.userName,
        value: message.event.bits,
        unit: 'bits',
        detailsJson: JSON.stringify({ isAnonymous: message.event.isAnonymous }),
      };
    case TWITCH_EVENT_CHANNEL_POINTS_REDEMPTION:
      return {
        providerEventId: message.event.redemptionId,
        kind: 'channel_points_redemption',
        occurredAt: new Date(message.event.redeemedAt),
        actorUserId: message.event.userId,
        actorLogin: message.event.userLogin,
        actorName: message.event.userName,
        value: message.event.cost,
        unit: 'channel_points',
        detailsJson: JSON.stringify({
          rewardId: message.event.rewardId,
          rewardTitle: message.event.rewardTitle,
        }),
      };
    case TWITCH_EVENT_CHANNEL_RAID: {
      const inbound =
        message.event.toBroadcasterUserId ===
        message.subscription.broadcasterId;
      return {
        kind: inbound ? 'raid_in' : 'raid_out',
        occurredAt: receivedAt,
        actorUserId: message.event.fromBroadcasterUserId,
        actorLogin: message.event.fromBroadcasterUserLogin,
        actorName: message.event.fromBroadcasterUserName,
        targetUserId: message.event.toBroadcasterUserId,
        targetLogin: message.event.toBroadcasterUserLogin,
        targetName: message.event.toBroadcasterUserName,
        quantity: message.event.viewers,
        unit: 'viewers',
      };
    }
  }
}
