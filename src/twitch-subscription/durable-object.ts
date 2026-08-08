import { DurableObject } from 'cloudflare:workers';
import { asc, count, eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import migrations from '../db/twitch-subscription/migrations/migrations.js';
import {
  broadcasters,
  eventSubSubscriptions,
  twitchSubscribers,
  type TwitchSubscriberPing,
} from '../db/twitch-subscription/schema';
import { requireDiscordSnowflake } from '../discord/snowflake';
import {
  createTwitchApiClient,
  TwitchApiError,
  type TwitchEventSubSubscription,
  type TwitchUser,
} from '../twitch/client';

const DESIRED_EVENT_TYPES = ['stream.online', 'stream.offline'] as const;
const ACTIVE_EVENTSUB_STATUSES = new Set([
  'enabled',
  'webhook_callback_verification_pending',
]);

export interface TwitchSubscriberRegistration {
  guildId: string;
  channelId: string;
  message?: string;
  offline?: string;
  ping?: TwitchSubscriberPing;
}

export interface TwitchSubscriber {
  broadcasterId: string;
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
    registration: TwitchSubscriberRegistration,
  ): Promise<void> {
    validateBroadcaster(broadcaster);
    validateRegistration(registration);
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
        channelId: registration.channelId,
        guildId: registration.guildId,
        message: registration.message ?? null,
        offline: registration.offline ?? null,
        ping: registration.ping ?? null,
      })
      .onConflictDoUpdate({
        target: twitchSubscribers.channelId,
        set: {
          guildId: registration.guildId,
          message: registration.message ?? null,
          offline: registration.offline ?? null,
          ping: registration.ping ?? null,
        },
      });
    await this.reconcile();
  }

  /** Removes the subscriber for a Discord channel and reconciles EventSub. */
  async removeSubscriber(channelId: string): Promise<boolean> {
    requireDiscordSnowflake(channelId, 'Discord channel ID');
    const [removed] = await this.db
      .delete(twitchSubscribers)
      .where(eq(twitchSubscribers.channelId, channelId))
      .returning({ channelId: twitchSubscribers.channelId });
    await this.reconcile();
    return removed !== undefined;
  }

  /** Lists this broadcaster's subscribers in a guild and reconciles EventSub. */
  async listSubscribers(guildId: string): Promise<TwitchSubscriber[]> {
    requireDiscordSnowflake(guildId, 'Discord guild ID');
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
      guildId: row.guildId,
      channelId: row.channelId,
      ...(row.message === null ? {} : { message: row.message }),
      ...(row.offline === null ? {} : { offline: row.offline }),
      ...(row.ping === null ? {} : { ping: row.ping }),
    }));
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
  if (!/^\d+$/.test(broadcaster.id))
    throw new Error('Twitch broadcaster ID is invalid');
  if (broadcaster.login.trim() === '')
    throw new Error('Twitch login cannot be empty');
}

function validateRegistration(
  registration: TwitchSubscriberRegistration,
): void {
  requireDiscordSnowflake(registration.guildId, 'Discord guild ID');
  requireDiscordSnowflake(registration.channelId, 'Discord channel ID');
  if (registration.message?.trim() === '')
    throw new Error('Subscriber message cannot be empty');
  if (registration.offline?.trim() === '')
    throw new Error('Subscriber offline message cannot be empty');
  if (
    registration.ping !== undefined &&
    registration.ping !== 'everyone' &&
    registration.ping !== 'here'
  ) {
    requireDiscordSnowflake(registration.ping, 'Discord role ID');
  }
}
