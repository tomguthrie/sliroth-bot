import { DurableObject } from 'cloudflare:workers';
import { and, count, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as z from 'zod';

import migrations from '../../db/twitch-subscription/migrations/migrations.js';
import {
  broadcasters,
  eventSubSubscriptions,
  processedEventSubMessages,
  streamMessages,
  streams,
  twitchSubscribers,
} from '../../db/twitch-subscription/schema';
import type { DiscordMessageReceipt } from '../../discord/client';
import { DiscordMentionTarget } from '../../discord/message';
import { DiscordSnowflake } from '../../discord/snowflake';
import { enqueueDiscordMessages } from '../../discord/queue';
import {
  type TwitchEventSubDelivery,
  type TwitchVodLookupDelivery,
} from './queue';
import {
  isTwitchApiErrorStatus,
  TwitchApiClient,
  type TwitchUser,
} from '../client';
import {
  TWITCH_EVENTSUB_SUBSCRIPTIONS,
  type ChannelUpdateEvent,
  type EventSubNotification,
  type EventSubSubscriptionDefinition,
  type StreamOfflineEvent,
  type StreamOnlineEvent,
} from '../eventsub';
import {
  createTwitchLiveDelivery,
  createTwitchLiveUpdateDelivery,
  createTwitchOfflineDelivery,
} from './discord-message';
import {
  createChannelTwitchSubscriptionKey,
  createGuildTwitchSubscriptionKey,
  type TwitchSubscriptionMetadata,
} from './index';

const ACTIVE_EVENTSUB_STATUSES = new Set([
  'enabled',
  'webhook_callback_verification_pending',
]);
const EVENTSUB_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EVENTSUB_MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

export const TwitchSubscriberRegistration = z.object({
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  message: z.string().trim().min(1).optional(),
  offline: z.string().trim().min(1).optional(),
  ping: DiscordMentionTarget.optional(),
});

export type TwitchSubscriberRegistration = z.infer<
  typeof TwitchSubscriberRegistration
>;
type TwitchSubscriberRegistrationInput = z.input<
  typeof TwitchSubscriberRegistration
>;

const TwitchBroadcaster = z.object({
  id: z.string().regex(/^\d+$/),
  login: z.string().min(1),
  displayName: z.string().trim().min(1),
  profileImageUrl: z.url(),
  offlineImageUrl: z.union([z.url(), z.literal('')]),
});

type TwitchEventSubSubscription = NonNullable<
  Awaited<ReturnType<TwitchApiClient['getEventSubSubscription']>>
>;

/** Coordinates subscribers and EventSub state for one Twitch broadcaster. */
export class TwitchSubscription extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase;
  private reconciliation: Promise<void> | undefined;
  private readonly eventSubProcessing = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.db = drizzle(this.ctx.storage);

    void ctx.blockConcurrencyWhile(() => {
      migrate(this.db, migrations);
      return Promise.resolve();
    });
  }

  /** Adds or updates a subscriber, then reconciles Twitch EventSub state. */
  async addSubscriber(
    broadcaster: TwitchUser,
    registration: TwitchSubscriberRegistrationInput,
  ): Promise<void> {
    const validatedBroadcaster = TwitchBroadcaster.parse(broadcaster);
    const validated = TwitchSubscriberRegistration.parse(registration);
    const [existingSubscriber] = await this.db
      .select({ guildId: twitchSubscribers.guildId })
      .from(twitchSubscribers)
      .where(eq(twitchSubscribers.channelId, validated.channelId))
      .limit(1);
    const guildId = existingSubscriber?.guildId ?? validated.guildId;
    await this.db
      .insert(broadcasters)
      .values({
        id: validatedBroadcaster.id,
        login: validatedBroadcaster.login,
        displayName: validatedBroadcaster.displayName,
        profileImageUrl: validatedBroadcaster.profileImageUrl,
        offlineImageUrl: validatedBroadcaster.offlineImageUrl,
      })
      .onConflictDoUpdate({
        target: broadcasters.id,
        set: {
          login: validatedBroadcaster.login,
          displayName: validatedBroadcaster.displayName,
          profileImageUrl: validatedBroadcaster.profileImageUrl,
          offlineImageUrl: validatedBroadcaster.offlineImageUrl,
        },
      });
    await this.db
      .insert(twitchSubscribers)
      .values({
        channelId: validated.channelId,
        guildId,
        message: validated.message ?? null,
        offline: validated.offline ?? null,
        ping: validated.ping ?? null,
      })
      .onConflictDoUpdate({
        target: twitchSubscribers.channelId,
        set: {
          message: validated.message ?? null,
          offline: validated.offline ?? null,
          ping: validated.ping ?? null,
        },
      });
    const metadata: TwitchSubscriptionMetadata = {
      login: validatedBroadcaster.login,
      displayName: validatedBroadcaster.displayName,
    };
    await Promise.all([
      this.env.TWITCH_SUBSCRIPTIONS_INDEX.put(
        createGuildTwitchSubscriptionKey(
          guildId,
          validated.channelId,
          validatedBroadcaster.id,
        ),
        '1',
        { metadata },
      ),
      this.env.TWITCH_SUBSCRIPTIONS_INDEX.put(
        createChannelTwitchSubscriptionKey(
          validated.channelId,
          validatedBroadcaster.id,
        ),
        '1',
      ),
    ]);
    await this.reconcile();
  }

  /** Removes the subscriber for a Discord channel and reconciles EventSub. */
  async removeSubscriber(channelId: string): Promise<boolean> {
    const validatedChannelId = DiscordSnowflake.parse(channelId);
    const broadcaster = await this.getBroadcaster();
    const [removed] = await this.db
      .delete(twitchSubscribers)
      .where(eq(twitchSubscribers.channelId, validatedChannelId))
      .returning({
        channelId: twitchSubscribers.channelId,
        guildId: twitchSubscribers.guildId,
      });
    if (removed !== undefined && broadcaster !== undefined) {
      await Promise.all([
        this.env.TWITCH_SUBSCRIPTIONS_INDEX.delete(
          createGuildTwitchSubscriptionKey(
            removed.guildId,
            removed.channelId,
            broadcaster.id,
          ),
        ),
        this.env.TWITCH_SUBSCRIPTIONS_INDEX.delete(
          createChannelTwitchSubscriptionKey(removed.channelId, broadcaster.id),
        ),
      ]);
    }
    await this.reconcile();
    return removed !== undefined;
  }

  /** Claims a live stream and queues one notification per subscriber. */
  async streamOnline(event: StreamOnlineEvent): Promise<void> {
    const broadcaster = await this.requireBroadcaster(event.broadcasterId);
    const startedAt = parseIsoDate(event.startedAt, 'stream start');
    const client = new TwitchApiClient(this.env);
    const liveStream = await client.getStream(broadcaster.id);
    if (liveStream?.id !== event.streamId) {
      throw new Error(`Twitch stream ${event.streamId} is not live`);
    }
    const game =
      liveStream.gameId === ''
        ? undefined
        : await client.getGame(liveStream.gameId);

    const [stream] = await this.db
      .insert(streams)
      .values({
        id: event.streamId,
        title:
          liveStream.title.trim() === ''
            ? `${broadcaster.displayName} is live`
            : liveStream.title,
        gameName:
          liveStream.gameName.trim() === ''
            ? 'No Category'
            : liveStream.gameName,
        viewerCount: liveStream.viewerCount,
        gameBoxArtUrl: game?.boxArtUrl ?? null,
        previewImageUrl: liveStream.thumbnailUrl,
        startedAt,
      })
      .onConflictDoNothing({ target: streams.id })
      .returning();
    if (stream === undefined) return;

    try {
      const subscriberRows = await this.db.select().from(twitchSubscribers);
      if (subscriberRows.length !== 0) {
        await this.db
          .insert(streamMessages)
          .values(
            subscriberRows.map((subscriber) => ({
              streamId: stream.id,
              channelId: subscriber.channelId,
              enqueuedRevision: stream.revision,
            })),
          )
          .onConflictDoNothing();
      }
      const previewCacheBustMs = Date.now();
      const deliveries = await Promise.all(
        subscriberRows.map((subscriber) =>
          createTwitchLiveDelivery(
            broadcaster,
            stream,
            subscriber,
            previewCacheBustMs,
          ),
        ),
      );
      await enqueueDiscordMessages(this.env.DISCORD_MESSAGES, deliveries);
    } catch (error) {
      await this.db
        .delete(streamMessages)
        .where(eq(streamMessages.streamId, stream.id));
      await this.db.delete(streams).where(eq(streams.id, stream.id));
      throw error;
    }
  }

  /** Refreshes delivered notifications from Twitch's current live stream. */
  async channelUpdate(event: ChannelUpdateEvent): Promise<void> {
    const broadcaster = await this.requireBroadcaster(event.broadcasterId);
    const client = new TwitchApiClient(this.env);
    const liveStream = await client.getStream(broadcaster.id);
    if (liveStream === undefined) return;

    const [stream] = await this.db
      .select({ id: streams.id, revision: streams.revision })
      .from(streams)
      .where(and(eq(streams.id, liveStream.id), isNull(streams.endedAt)))
      .limit(1);
    if (stream === undefined) return;

    const game =
      liveStream.gameId === ''
        ? undefined
        : await client.getGame(liveStream.gameId);
    const [updatedStream] = await this.db
      .update(streams)
      .set({
        title:
          liveStream.title.trim() === ''
            ? `${broadcaster.displayName} is live`
            : liveStream.title,
        gameName:
          liveStream.gameName.trim() === ''
            ? 'No Category'
            : liveStream.gameName,
        viewerCount: liveStream.viewerCount,
        gameBoxArtUrl: game?.boxArtUrl ?? null,
        previewImageUrl: liveStream.thumbnailUrl,
        revision: stream.revision + 1,
      })
      .where(
        and(
          eq(streams.id, stream.id),
          eq(streams.revision, stream.revision),
          isNull(streams.endedAt),
        ),
      )
      .returning({ id: streams.id });
    if (updatedStream !== undefined) {
      await this.queueStreamUpdates(updatedStream.id);
    }
  }

  /** Marks the current stream offline and edits delivered notifications. */
  async streamOffline(
    event: StreamOfflineEvent,
    endedAtValue: string,
  ): Promise<void> {
    await this.requireBroadcaster(event.broadcasterId);
    const endedAt = parseIsoDate(endedAtValue, 'stream end');
    const [stream] = await this.db
      .select()
      .from(streams)
      .where(eq(streams.id, event.streamId))
      .limit(1);
    if (stream === undefined) return;

    if (stream.endedAt === null) {
      const [updatedStream] = await this.db
        .update(streams)
        .set({ endedAt, revision: stream.revision + 1 })
        .where(and(eq(streams.id, stream.id), isNull(streams.endedAt)))
        .returning({ id: streams.id });
      if (updatedStream !== undefined) {
        await this.queueStreamUpdates(updatedStream.id);
      }
    }

    if (stream.vodUrl === null) {
      const delivery: TwitchVodLookupDelivery = {
        kind: 'twitch-vod-lookup',
        broadcasterId: event.broadcasterId,
        streamId: event.streamId,
      };
      await this.env.SUBSCRIPTION_EVENTS.send(delivery, { delaySeconds: 30 });
    }
  }

  /** Records a published archive URL for an ended stream. */
  async recordStreamVod(
    streamIdValue: string,
    vodUrlValue: string,
  ): Promise<void> {
    const streamId = requireNonBlank(streamIdValue, 'Twitch stream ID');
    const vodUrl = z.url().parse(vodUrlValue);
    const [stream] = await this.db
      .select()
      .from(streams)
      .where(eq(streams.id, streamId))
      .limit(1);
    if (stream === undefined) {
      return;
    }
    if (stream.endedAt === null) {
      return;
    }
    if (stream.vodUrl !== null) {
      await this.queueStreamUpdates(stream.id);
      return;
    }

    const [updatedStream] = await this.db
      .update(streams)
      .set({ vodUrl, revision: stream.revision + 1 })
      .where(
        and(
          eq(streams.id, stream.id),
          eq(streams.revision, stream.revision),
          isNotNull(streams.endedAt),
          isNull(streams.vodUrl),
        ),
      )
      .returning({ id: streams.id });
    if (updatedStream === undefined) return;
    await this.queueStreamUpdates(updatedStream.id);
  }

  /** Records Discord's create-message receipt for a queued live message. */
  async recordDiscordMessage(
    streamId: string,
    receipt: DiscordMessageReceipt,
  ): Promise<void> {
    const validatedStreamId = requireNonBlank(streamId, 'Twitch stream ID');
    const [message] = await this.db
      .update(streamMessages)
      .set({ messageId: receipt.messageId })
      .where(
        and(
          eq(streamMessages.streamId, validatedStreamId),
          eq(streamMessages.channelId, receipt.channelId),
        ),
      )
      .returning({ channelId: streamMessages.channelId });
    if (message !== undefined) {
      await this.queueStreamUpdates(validatedStreamId, message.channelId);
    }
  }

  /** Idempotently applies a queued EventSub message and repairs subscriptions. */
  processEventSubMessage(delivery: TwitchEventSubDelivery): Promise<void> {
    const existing = this.eventSubProcessing.get(delivery.messageId);
    if (existing !== undefined) return existing;

    const processing = this.processEventSubMessageNow(delivery).finally(() => {
      if (this.eventSubProcessing.get(delivery.messageId) === processing) {
        this.eventSubProcessing.delete(delivery.messageId);
      }
    });
    this.eventSubProcessing.set(delivery.messageId, processing);
    return processing;
  }

  /** Removes a revoked local subscription so reconciliation recreates it. */
  async revokeEventSub(subscriptionId: string): Promise<void> {
    const validatedSubscriptionId = requireNonBlank(
      subscriptionId,
      'Twitch EventSub subscription ID',
    );
    await this.db
      .delete(eventSubSubscriptions)
      .where(eq(eventSubSubscriptions.subscriptionId, validatedSubscriptionId));
    await this.reconcile();
  }

  /** Makes remote subscriptions match the currently desired event types. */
  reconcile(): Promise<void> {
    if (this.reconciliation !== undefined) return this.reconciliation;
    const reconciliation = this.reconcileNow().finally(() => {
      if (this.reconciliation === reconciliation) {
        this.reconciliation = undefined;
      }
    });
    this.reconciliation = reconciliation;
    return reconciliation;
  }

  private async reconcileNow(): Promise<void> {
    const broadcaster = await this.getBroadcaster();
    if (broadcaster === undefined) return;
    const [subscriberCount] = await this.db
      .select({ value: count() })
      .from(twitchSubscribers);
    if (subscriberCount === undefined) {
      throw new Error('Failed to count Twitch subscribers');
    }
    const desiredSubscriptions: readonly EventSubSubscriptionDefinition[] =
      subscriberCount.value === 0 ? [] : TWITCH_EVENTSUB_SUBSCRIPTIONS;
    const client = new TwitchApiClient(this.env);
    const callback = new URL(
      `/twitch/eventsub/${broadcaster.id}`,
      this.env.PUBLIC_BASE_URL,
    ).toString();
    const rows = await this.db.select().from(eventSubSubscriptions);

    for (const row of rows) {
      if (
        !desiredSubscriptions.some(
          (subscription) => subscription.type === row.type,
        )
      ) {
        await deleteRemoteSubscription(client, row.subscriptionId);
        await this.deleteLocalSubscription(row.type);
      }
    }

    for (const desired of desiredSubscriptions) {
      const row = rows.find((candidate) => candidate.type === desired.type);
      if (row !== undefined) {
        const remote = await getRemoteSubscription(client, row.subscriptionId);
        if (isDesiredSubscription(remote, desired, broadcaster.id, callback)) {
          continue;
        }
        if (remote !== undefined) {
          await deleteRemoteSubscription(client, remote.id);
        }
        await this.deleteLocalSubscription(desired.type);
      }

      const created = await client.createEventSubSubscription({
        type: desired.type,
        version: desired.version,
        condition: { broadcaster_user_id: broadcaster.id },
        transport: {
          method: 'webhook',
          callback,
          secret: this.env.TWITCH_EVENTSUB_SECRET,
        },
      });
      await this.db
        .insert(eventSubSubscriptions)
        .values({ type: desired.type, subscriptionId: created.id })
        .onConflictDoUpdate({
          target: eventSubSubscriptions.type,
          set: { subscriptionId: created.id },
        });
    }

    await this.db
      .update(broadcasters)
      .set({ eventSubAuditedAt: new Date() })
      .where(eq(broadcasters.id, broadcaster.id));
  }

  private async processEventSubMessageNow(
    delivery: TwitchEventSubDelivery,
  ): Promise<void> {
    const [processed] = await this.db
      .select({ messageId: processedEventSubMessages.messageId })
      .from(processedEventSubMessages)
      .where(eq(processedEventSubMessages.messageId, delivery.messageId))
      .limit(1);

    if (processed === undefined) {
      const { message } = delivery;
      if (message.messageType === 'revocation') {
        await this.revokeEventSub(message.subscription.id);
      } else {
        switch (message.eventType) {
          case 'channel.update':
            await this.channelUpdate(message.event);
            break;
          case 'stream.online':
            await this.streamOnline(message.event);
            break;
          case 'stream.offline':
            await this.streamOffline(message.event, delivery.timestamp);
            break;
        }
      }

      const processedAt = new Date();
      await this.db
        .insert(processedEventSubMessages)
        .values({ messageId: delivery.messageId, processedAt })
        .onConflictDoNothing({ target: processedEventSubMessages.messageId });
      await this.db
        .delete(processedEventSubMessages)
        .where(
          lt(
            processedEventSubMessages.processedAt,
            new Date(processedAt.getTime() - EVENTSUB_MESSAGE_RETENTION_MS),
          ),
        );
    }

    if (delivery.message.messageType === 'notification') {
      await this.recordIncomingEventSubSubscription(delivery.message);
      await this.repairMissingEventSubSubscriptions();
      await this.auditEventSubSubscriptionsIfDue();
    }
  }

  private async recordIncomingEventSubSubscription(
    message: EventSubNotification,
  ): Promise<void> {
    await this.db
      .insert(eventSubSubscriptions)
      .values({
        type: message.eventType,
        subscriptionId: message.subscription.id,
      })
      .onConflictDoUpdate({
        target: eventSubSubscriptions.type,
        set: { subscriptionId: message.subscription.id },
      });
  }

  private async repairMissingEventSubSubscriptions(): Promise<void> {
    const broadcaster = await this.getBroadcaster();
    if (broadcaster === undefined) return;
    const [subscriberCount] = await this.db
      .select({ value: count() })
      .from(twitchSubscribers);
    if (subscriberCount?.value === 0) return;

    const rows = await this.db.select().from(eventSubSubscriptions);
    const client = new TwitchApiClient(this.env);
    const callback = new URL(
      `/twitch/eventsub/${broadcaster.id}`,
      this.env.PUBLIC_BASE_URL,
    ).toString();
    for (const desired of TWITCH_EVENTSUB_SUBSCRIPTIONS) {
      if (rows.some((row) => row.type === desired.type)) continue;
      const created = await client.createEventSubSubscription({
        type: desired.type,
        version: desired.version,
        condition: { broadcaster_user_id: broadcaster.id },
        transport: {
          method: 'webhook',
          callback,
          secret: this.env.TWITCH_EVENTSUB_SECRET,
        },
      });
      await this.db
        .insert(eventSubSubscriptions)
        .values({ type: desired.type, subscriptionId: created.id })
        .onConflictDoUpdate({
          target: eventSubSubscriptions.type,
          set: { subscriptionId: created.id },
        });
    }
  }

  private async auditEventSubSubscriptionsIfDue(): Promise<void> {
    const broadcaster = await this.getBroadcaster();
    if (
      broadcaster?.eventSubAuditedAt !== null &&
      broadcaster?.eventSubAuditedAt !== undefined &&
      broadcaster.eventSubAuditedAt.getTime() >
        Date.now() - EVENTSUB_AUDIT_INTERVAL_MS
    ) {
      return;
    }
    await this.reconcile();
  }

  private async requireBroadcaster(broadcasterId: string): Promise<TwitchUser> {
    const broadcaster = await this.getBroadcaster();
    if (broadcaster === undefined) {
      throw new Error('Twitch broadcaster has not been registered');
    }
    if (broadcaster.id !== broadcasterId) {
      throw new Error(
        `Twitch broadcaster ${broadcasterId} does not match ${broadcaster.id}`,
      );
    }
    return broadcaster;
  }

  private async queueStreamUpdates(
    streamId: string,
    channelId?: string,
  ): Promise<void> {
    const [broadcaster, stream] = await Promise.all([
      this.getBroadcaster(),
      this.db
        .select()
        .from(streams)
        .where(eq(streams.id, streamId))
        .limit(1)
        .then(([value]) => value),
    ]);
    if (broadcaster === undefined || stream === undefined) {
      return;
    }

    const messages = await this.db
      .select()
      .from(streamMessages)
      .where(
        channelId === undefined
          ? and(
              eq(streamMessages.streamId, streamId),
              lt(streamMessages.enqueuedRevision, stream.revision),
            )
          : and(
              eq(streamMessages.streamId, streamId),
              eq(streamMessages.channelId, channelId),
              lt(streamMessages.enqueuedRevision, stream.revision),
            ),
      );
    const subscriberRows = await this.db.select().from(twitchSubscribers);
    const subscribersByChannel = new Map(
      subscriberRows.map((subscriber) => [subscriber.channelId, subscriber]),
    );
    const previewCacheBustMs = Date.now();
    const deliveredMessages = messages.flatMap((message) => {
      const subscriber = subscribersByChannel.get(message.channelId);
      if (message.messageId === null || subscriber === undefined) return [];
      return [
        {
          channelId: message.channelId,
          delivery:
            stream.endedAt === null
              ? createTwitchLiveUpdateDelivery(
                  broadcaster,
                  stream,
                  subscriber,
                  message.messageId,
                  previewCacheBustMs,
                )
              : createTwitchOfflineDelivery(
                  broadcaster,
                  stream,
                  subscriber,
                  message.messageId,
                ),
        },
      ];
    });

    await enqueueDiscordMessages(
      this.env.DISCORD_MESSAGES,
      deliveredMessages.map(({ delivery }) => delivery),
    );
    await Promise.all(
      deliveredMessages.map(({ channelId: deliveredChannelId }) =>
        this.db
          .update(streamMessages)
          .set({ enqueuedRevision: stream.revision })
          .where(
            and(
              eq(streamMessages.streamId, streamId),
              eq(streamMessages.channelId, deliveredChannelId),
            ),
          ),
      ),
    );
  }

  private async getBroadcaster(): Promise<
    typeof broadcasters.$inferSelect | undefined
  > {
    const [broadcaster] = await this.db.select().from(broadcasters).limit(1);
    return broadcaster;
  }

  private async deleteLocalSubscription(type: string): Promise<void> {
    await this.db
      .delete(eventSubSubscriptions)
      .where(eq(eventSubSubscriptions.type, type));
  }
}

async function getRemoteSubscription(
  client: TwitchApiClient,
  id: string,
): Promise<TwitchEventSubSubscription | undefined> {
  try {
    return await client.getEventSubSubscription(id);
  } catch (error) {
    if (isTwitchApiErrorStatus(error, 404)) return undefined;
    throw error;
  }
}

async function deleteRemoteSubscription(
  client: TwitchApiClient,
  id: string,
): Promise<void> {
  try {
    await client.deleteEventSubSubscription(id);
  } catch (error) {
    if (!isTwitchApiErrorStatus(error, 404)) throw error;
  }
}

function isDesiredSubscription(
  subscription: TwitchEventSubSubscription | undefined,
  desired: EventSubSubscriptionDefinition,
  broadcasterId: string,
  callback: string,
): boolean {
  return (
    subscription?.type === desired.type &&
    subscription.version === desired.version &&
    subscription.condition.broadcaster_user_id === broadcasterId &&
    subscription.transport.method === 'webhook' &&
    subscription.transport.callback === callback &&
    ACTIVE_EVENTSUB_STATUSES.has(subscription.status)
  );
}

function requireNonBlank(value: string, name: string): string {
  if (value.trim() === '') {
    throw new Error(`${name} must not be blank`);
  }
  return value;
}

function parseIsoDate(value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return date;
}
