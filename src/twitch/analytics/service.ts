import { count, eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import {
  analyticsAuthorization,
  analyticsOauthStates,
  analyticsPendingFinalizers,
  analyticsRuntime,
  eventSubSubscriptions,
  twitchSubscribers,
} from '../../db/twitch-subscription/schema';
import { toLoggableError } from '../../log';
import { isTwitchApiErrorStatus, TwitchApiClient } from '../client';
import { TWITCH_EVENT_STREAM_ONLINE } from '../eventsub';
import type { TwitchEventSubDelivery } from '../subscription/queue';
import {
  isTwitchOAuthErrorStatus,
  refreshUserToken,
  revokeUserToken,
} from './oauth';

/** Retires the deployed Twitch analytics integration on the next stream. */
export class TwitchAnalyticsService {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly localDb: DrizzleSqliteDODatabase,
  ) {}

  /** Stops scheduled analytics work without changing EventSub state. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    console.info({ event: 'twitch_analytics_collection_stopped' });
  }

  /** Retires analytics when the configured channel next starts streaming. */
  async processEventSub(delivery: TwitchEventSubDelivery): Promise<boolean> {
    if (
      delivery.message.messageType !== 'notification' ||
      delivery.message.eventType !== TWITCH_EVENT_STREAM_ONLINE ||
      delivery.message.subscription.broadcasterId !==
        this.env.TWITCH_ANALYTICS_CHANNEL_ID
    ) {
      return false;
    }

    await this.teardown();
    return true;
  }

  private async teardown(): Promise<void> {
    const rows = await this.localDb.select().from(eventSubSubscriptions);
    const [subscriberCount] = await this.localDb
      .select({ value: count() })
      .from(twitchSubscribers);
    if (subscriberCount === undefined) {
      throw new Error('Failed to count Twitch subscribers');
    }

    const subscriptionsToDelete =
      subscriberCount.value === 0
        ? rows
        : rows.filter(({ subscriptionKey }) =>
            subscriptionKey.startsWith('analytics:'),
          );
    const client = new TwitchApiClient(this.env);
    for (const subscription of subscriptionsToDelete) {
      await deleteRemoteSubscription(client, subscription.subscriptionId);
    }

    const [authorization] = await this.localDb
      .select()
      .from(analyticsAuthorization)
      .limit(1);
    if (authorization !== undefined) {
      await revokeAuthorization(this.env, authorization);
    }

    for (const subscription of subscriptionsToDelete) {
      await this.localDb
        .delete(eventSubSubscriptions)
        .where(
          eq(
            eventSubSubscriptions.subscriptionKey,
            subscription.subscriptionKey,
          ),
        );
    }
    await this.localDb.delete(analyticsPendingFinalizers);
    await this.localDb.delete(analyticsOauthStates);
    await this.localDb.delete(analyticsRuntime);
    await this.localDb.delete(analyticsAuthorization);
    await this.ctx.storage.deleteAlarm();

    console.info({
      event: 'twitch_analytics_teardown_complete',
      deletedEventSubSubscriptions: subscriptionsToDelete.length,
      preservedEventSubSubscriptions:
        rows.length - subscriptionsToDelete.length,
      revokedAuthorization: authorization !== undefined,
    });
  }
}

async function deleteRemoteSubscription(
  client: TwitchApiClient,
  subscriptionId: string,
): Promise<void> {
  try {
    await client.deleteEventSubSubscription(subscriptionId);
  } catch (error) {
    if (!isTwitchApiErrorStatus(error, 404)) throw error;
  }
}

async function revokeAuthorization(
  env: Env,
  authorization: typeof analyticsAuthorization.$inferSelect,
): Promise<void> {
  try {
    await revokeUserToken(env.TWITCH_CLIENT_ID, authorization.accessToken);
    return;
  } catch (error) {
    if (!isTwitchOAuthErrorStatus(error, 400)) throw error;
  }

  try {
    const refreshed = await refreshUserToken(env, authorization.refreshToken);
    await revokeUserToken(env.TWITCH_CLIENT_ID, refreshed.access_token);
  } catch (error) {
    if (
      !isTwitchOAuthErrorStatus(error, 400) &&
      !isTwitchOAuthErrorStatus(error, 401)
    ) {
      console.error({
        event: 'twitch_analytics_authorization_revocation_failed',
        error: toLoggableError(error),
      });
      throw error;
    }
  }
}
