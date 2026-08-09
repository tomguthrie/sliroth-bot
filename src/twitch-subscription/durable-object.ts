import { DurableObject } from 'cloudflare:workers';
import { and, asc, count, eq, lt } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as z from 'zod';

import migrations from '../db/twitch-subscription/migrations/migrations.js';
import {
  broadcasters,
  eventSubSubscriptions,
  streamMessages,
  streams,
  twitchSubscribers,
} from '../db/twitch-subscription/schema';
import type { DiscordMessageReceipt } from '../discord/client';
import { DiscordSnowflake } from '../discord/snowflake';
import { enqueueDiscordMessages } from '../queue/discord-message';
import {
  createTwitchApiClient,
  TwitchApiError,
  type TwitchEventSubSubscription,
  type TwitchUser,
} from '../twitch/client';
import type {
  TwitchStreamOfflineEvent,
  TwitchStreamOnlineEvent,
} from '../twitch/eventsub-handler';
import {
  TWITCH_EVENT_STREAM_OFFLINE,
  TWITCH_EVENT_STREAM_ONLINE,
} from '../twitch/eventsub-handler';
import {
  TwitchLiveDiscordMessage,
  TwitchOfflineDiscordMessage,
} from './discord-message';
import {
  channelTwitchSubscriptionKey,
  guildTwitchSubscriptionKey,
} from './index';

const DESIRED_EVENT_TYPES = [
  TWITCH_EVENT_STREAM_ONLINE,
  TWITCH_EVENT_STREAM_OFFLINE,
] as const;
const ACTIVE_EVENTSUB_STATUSES = new Set([
  'enabled',
  'webhook_callback_verification_pending',
]);

const TwitchBroadcaster: z.ZodType<TwitchUser> = z.object({
  id: z.string().regex(/^\d+$/, { error: 'Twitch broadcaster ID is invalid' }),
  login: nonBlankStringSchema('Twitch login'),
  displayName: nonBlankStringSchema('Twitch display name'),
  profileImageUrl: z.string(),
  offlineImageUrl: z.string(),
});

export const TwitchSubscriberRegistration = z.object({
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  message: nonBlankStringSchema('Subscriber message').optional(),
  offline: nonBlankStringSchema('Subscriber offline message').optional(),
  ping: z
    .union([z.literal('everyone'), z.literal('here'), DiscordSnowflake])
    .optional(),
});

export type TwitchSubscriberRegistration = z.infer<
  typeof TwitchSubscriberRegistration
>;
type TwitchSubscriberRegistrationInput = z.input<
  typeof TwitchSubscriberRegistration
>;

export interface TwitchSubscriber {
  broadcasterId: string;
  broadcasterLogin: string;
  broadcasterDisplayName: string;
  guildId: string;
  channelId: string;
  message?: string;
  offline?: string;
  ping?: string;
}

/** Coordinates subscribers and EventSub state for one Twitch broadcaster. */
export class TwitchSubscription extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase;
  private reconciliation?: Promise<void>;

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
    validateBroadcaster(broadcaster);
    const validated = validateRegistration(registration);
    const [existingSubscriber] = await this.db
      .select({ guildId: twitchSubscribers.guildId })
      .from(twitchSubscribers)
      .where(eq(twitchSubscribers.channelId, validated.channelId))
      .limit(1);
    const guildId = existingSubscriber?.guildId ?? validated.guildId;
    await this.db
      .insert(broadcasters)
      .values({
        id: broadcaster.id,
        login: broadcaster.login,
        displayName: broadcaster.displayName,
        profileImageUrl: broadcaster.profileImageUrl,
        offlineImageUrl: broadcaster.offlineImageUrl,
      })
      .onConflictDoUpdate({
        target: broadcasters.id,
        set: {
          login: broadcaster.login,
          displayName: broadcaster.displayName,
          profileImageUrl: broadcaster.profileImageUrl,
          offlineImageUrl: broadcaster.offlineImageUrl,
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
    await Promise.all([
      this.env.TWITCH_SUBSCRIPTIONS_INDEX.put(
        guildTwitchSubscriptionKey(
          guildId,
          validated.channelId,
          broadcaster.id,
        ),
        '1',
      ),
      this.env.TWITCH_SUBSCRIPTIONS_INDEX.put(
        channelTwitchSubscriptionKey(validated.channelId, broadcaster.id),
        '1',
      ),
    ]);
    await this.reconcile();
  }

  /** Removes the subscriber for a Discord channel and reconciles EventSub. */
  async removeSubscriber(channelId: string): Promise<boolean> {
    DiscordSnowflake.parse(channelId);
    const broadcaster = await this.getBroadcaster();
    const [removed] = await this.db
      .delete(twitchSubscribers)
      .where(eq(twitchSubscribers.channelId, channelId))
      .returning({
        channelId: twitchSubscribers.channelId,
        guildId: twitchSubscribers.guildId,
      });
    if (removed !== undefined && broadcaster !== undefined) {
      await Promise.all([
        this.env.TWITCH_SUBSCRIPTIONS_INDEX.delete(
          guildTwitchSubscriptionKey(
            removed.guildId,
            removed.channelId,
            broadcaster.id,
          ),
        ),
        this.env.TWITCH_SUBSCRIPTIONS_INDEX.delete(
          channelTwitchSubscriptionKey(removed.channelId, broadcaster.id),
        ),
      ]);
    }
    await this.reconcile();
    return removed !== undefined;
  }

  /** Lists this broadcaster's subscribers in a guild and reconciles EventSub. */
  async listSubscribers(guildId: string): Promise<TwitchSubscriber[]> {
    DiscordSnowflake.parse(guildId);
    const broadcaster = await this.getBroadcaster();
    const rows = await this.db
      .select()
      .from(twitchSubscribers)
      .where(eq(twitchSubscribers.guildId, guildId))
      .orderBy(asc(twitchSubscribers.channelId));
    await this.reconcile();
    if (broadcaster === undefined) return [];
    return rows.map((row) => ({
      broadcasterId: broadcaster.id,
      broadcasterLogin: broadcaster.login,
      broadcasterDisplayName: broadcaster.displayName,
      guildId: row.guildId,
      channelId: row.channelId,
      ...(row.message === null ? {} : { message: row.message }),
      ...(row.offline === null ? {} : { offline: row.offline }),
      ...(row.ping === null ? {} : { ping: row.ping }),
    }));
  }

  /** Claims a live stream and queues one notification per subscriber. */
  async streamOnline(event: TwitchStreamOnlineEvent): Promise<void> {
    const broadcaster = await this.requireBroadcaster(
      event.broadcaster_user_id,
    );
    requireNonEmpty(event.id, 'Twitch stream ID');
    const startedAt = requireTimestamp(
      event.started_at,
      'Twitch stream start timestamp',
    );
    const client = createTwitchApiClient(this.env);
    const liveStream = await client.getStreamByUserId(broadcaster.id);
    if (liveStream?.id !== event.id) {
      throw new Error(`Twitch stream ${event.id} is not live`);
    }
    const game =
      liveStream.gameId === ''
        ? undefined
        : await client.getGameById(liveStream.gameId);

    const [stream] = await this.db
      .insert(streams)
      .values({
        id: event.id,
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
      const deliveries = await Promise.all(
        subscriberRows.map((subscriber) =>
          TwitchLiveDiscordMessage.build(broadcaster, stream, subscriber),
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

  /** Marks the current stream offline and edits delivered notifications. */
  async streamOffline(
    event: TwitchStreamOfflineEvent,
    endedAtValue: string,
  ): Promise<void> {
    const broadcaster = await this.requireBroadcaster(
      event.broadcaster_user_id,
    );
    requireNonEmpty(event.id, 'Twitch stream ID');
    const endedAt = requireTimestamp(
      endedAtValue,
      'Twitch stream end timestamp',
    );
    const [stream] = await this.db
      .select()
      .from(streams)
      .where(eq(streams.id, event.id))
      .limit(1);
    if (stream === undefined) return;

    const vods = await createTwitchApiClient(this.env).getArchiveVideosByUserId(
      broadcaster.id,
    );
    const vod = vods.find((candidate) => candidate.streamId === stream.id);
    const revisionChanged =
      stream.endedAt === null || (stream.vodUrl === null && vod !== undefined);
    const [updatedStream] = await this.db
      .update(streams)
      .set({
        endedAt: stream.endedAt ?? endedAt,
        vodUrl: stream.vodUrl ?? vod?.url ?? null,
        revision: revisionChanged ? stream.revision + 1 : stream.revision,
      })
      .where(eq(streams.id, stream.id))
      .returning({ id: streams.id });
    if (updatedStream !== undefined) {
      await this.queueStreamUpdates(updatedStream.id);
    }
  }

  /** Records Discord's create-message receipt for a queued live message. */
  async recordDiscordMessage(
    streamId: string,
    receipt: DiscordMessageReceipt,
  ): Promise<void> {
    requireNonEmpty(streamId, 'Twitch stream ID');
    DiscordSnowflake.parse(receipt.channelId);
    DiscordSnowflake.parse(receipt.messageId);
    const [message] = await this.db
      .update(streamMessages)
      .set({ messageId: receipt.messageId })
      .where(
        and(
          eq(streamMessages.streamId, streamId),
          eq(streamMessages.channelId, receipt.channelId),
        ),
      )
      .returning({ channelId: streamMessages.channelId });
    if (message !== undefined) {
      await this.queueStreamUpdates(streamId, message.channelId);
    }
  }

  /** Removes a revoked local subscription so reconciliation recreates it. */
  async revokeEventSub(subscriptionId: string): Promise<void> {
    await this.db
      .delete(eventSubSubscriptions)
      .where(eq(eventSubSubscriptions.subscriptionId, subscriptionId));
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
    const desiredTypes: readonly string[] =
      subscriberCount.value === 0 ? [] : DESIRED_EVENT_TYPES;
    const client = createTwitchApiClient(this.env);
    const callback = new URL(
      `/twitch/eventsub/${broadcaster.id}`,
      this.env.PUBLIC_BASE_URL,
    ).toString();
    const rows = await this.db.select().from(eventSubSubscriptions);

    for (const row of rows) {
      if (!desiredTypes.includes(row.type)) {
        await deleteRemoteSubscription(client, row.subscriptionId);
        await this.deleteLocalSubscription(row.type);
      }
    }

    for (const type of desiredTypes) {
      const row = rows.find((candidate) => candidate.type === type);
      if (row !== undefined) {
        const remote = await getRemoteSubscription(client, row.subscriptionId);
        if (isDesiredSubscription(remote, type, broadcaster.id, callback)) {
          continue;
        }
        if (remote !== undefined) {
          await deleteRemoteSubscription(client, remote.id);
        }
        await this.deleteLocalSubscription(type);
      }

      const created = await client.createEventSubSubscription({
        type,
        version: '1',
        condition: { broadcaster_user_id: broadcaster.id },
        callback,
        secret: this.env.TWITCH_EVENTSUB_SECRET,
      });
      await this.db
        .insert(eventSubSubscriptions)
        .values({ type, subscriptionId: created.id })
        .onConflictDoUpdate({
          target: eventSubSubscriptions.type,
          set: { subscriptionId: created.id },
        });
    }
  }

  private async requireBroadcaster(
    broadcasterId: string,
  ): Promise<typeof broadcasters.$inferSelect> {
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
    if (broadcaster === undefined || stream?.endedAt == null) {
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
    const deliveredMessages = messages.flatMap((message) => {
      const subscriber = subscribersByChannel.get(message.channelId);
      if (message.messageId === null || subscriber === undefined) return [];
      return [
        {
          channelId: message.channelId,
          delivery: TwitchOfflineDiscordMessage.build(
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
  client: ReturnType<typeof createTwitchApiClient>,
  id: string,
): Promise<TwitchEventSubSubscription | undefined> {
  try {
    return await client.getEventSubSubscriptionById(id);
  } catch (error) {
    if (error instanceof TwitchApiError && error.status === 404)
      return undefined;
    throw error;
  }
}

async function deleteRemoteSubscription(
  client: ReturnType<typeof createTwitchApiClient>,
  id: string,
): Promise<void> {
  try {
    await client.deleteEventSubSubscription(id);
  } catch (error) {
    if (!(error instanceof TwitchApiError) || error.status !== 404) throw error;
  }
}

function isDesiredSubscription(
  subscription: TwitchEventSubSubscription | undefined,
  type: string,
  broadcasterId: string,
  callback: string,
): boolean {
  return (
    subscription?.type === type &&
    subscription.version === '1' &&
    subscription.condition.broadcaster_user_id === broadcasterId &&
    subscription.transport.method === 'webhook' &&
    subscription.transport.callback === callback &&
    ACTIVE_EVENTSUB_STATUSES.has(subscription.status)
  );
}

function validateBroadcaster(broadcaster: TwitchUser): void {
  const result = TwitchBroadcaster.safeParse(broadcaster);
  if (!result.success) {
    throw new Error(
      result.error.issues[0]?.message ?? 'Twitch broadcaster is invalid',
      { cause: result.error },
    );
  }
}

function validateRegistration(
  registration: TwitchSubscriberRegistrationInput,
): TwitchSubscriberRegistration {
  const result = TwitchSubscriberRegistration.safeParse(registration);
  if (!result.success) {
    throw new Error(
      result.error.issues[0]?.message ??
        'Twitch subscriber registration is invalid',
      { cause: result.error },
    );
  }
  return result.data;
}

function nonBlankStringSchema(name: string) {
  const error = `${name} cannot be empty`;
  return z.string({ error }).refine((value) => value.trim() !== '', { error });
}

function requireNonEmpty(value: string, description: string): void {
  if (value.trim() === '') throw new Error(`${description} cannot be empty`);
}

function requireTimestamp(value: string, description: string): Date {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`${description} is invalid`);
  }
  return timestamp;
}
