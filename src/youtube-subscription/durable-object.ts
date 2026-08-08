import { DurableObject } from 'cloudflare:workers';
import { count, eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import migrations from '../db/youtube-subscription/migrations/migrations.js';
import {
  subscribers,
  type SubscriberPing,
  videos,
} from '../db/youtube-subscription/schema';
import { enqueueDiscordMessages } from '../queue/discord-message';
import {
  parseYouTubeVideoNotifications,
  type YouTubeVideoNotification,
} from '../youtube/notification';
import {
  createYouTubeTopicUrl,
  createYouTubeWebSubRequest,
  type WebSubMode,
  verifyYouTubeWebSubSignature,
} from '../youtube/websub';
import { createYouTubeDiscordMessage } from './discord-message';
import { channelSubscriptionKey, guildSubscriptionKey } from './index';

const SUBSCRIPTION_INDEX_VALUE = '1';
const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;
const WEBSUB_SECRET_KEY = 'websub:secret';
const WEBSUB_STATUS_KEY = 'websub:status';
const WEBSUB_RETRY_DELAY_MS = 5 * 60 * 1000;
const WEBSUB_RENEWAL_FRACTION = 0.8;

type WebSubStatus = 'subscribing' | 'subscribed' | 'unsubscribing';

interface WebSubState {
  secret?: string;
  status?: WebSubStatus;
}

export interface YouTubeSubscriberRegistration {
  guildId: string;
  channelId: string;
  message?: string;
  ping?: SubscriberPing;
}

export class YouTubeSubscription extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.db = drizzle(this.ctx.storage);

    void ctx.blockConcurrencyWhile(() => {
      migrate(this.db, migrations);
      return Promise.resolve();
    });
  }

  /** Adds or updates a Discord subscriber and its global lookup indexes. */
  async addSubscriber(
    registration: YouTubeSubscriberRegistration,
  ): Promise<void> {
    validateSubscriberRegistration(registration);
    const youtubeChannelId = this.requireYouTubeChannelId();
    const [subscriber] = await this.db
      .insert(subscribers)
      .values({
        guildId: registration.guildId,
        channelId: registration.channelId,
        message: registration.message ?? null,
        ping: registration.ping ?? null,
      })
      .onConflictDoUpdate({
        target: subscribers.channelId,
        set: {
          message: registration.message ?? null,
          ping: registration.ping ?? null,
          updatedAt: new Date(),
        },
      })
      .returning({
        guildId: subscribers.guildId,
        channelId: subscribers.channelId,
      });

    if (subscriber === undefined) {
      throw new Error('Failed to store YouTube subscriber');
    }

    await Promise.all([
      this.env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
        guildSubscriptionKey(
          subscriber.guildId,
          subscriber.channelId,
          youtubeChannelId,
        ),
        SUBSCRIPTION_INDEX_VALUE,
      ),
      this.env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
        channelSubscriptionKey(subscriber.channelId, youtubeChannelId),
        SUBSCRIPTION_INDEX_VALUE,
      ),
    ]);

    await this.ensureWebSubSubscribed();
  }

  /** Removes a Discord subscriber and its global lookup indexes. */
  async removeSubscriber(channelId: string): Promise<void> {
    requireDiscordSnowflake(channelId, 'Discord channel ID');
    const youtubeChannelId = this.requireYouTubeChannelId();
    const [subscriber] = await this.db
      .select({ guildId: subscribers.guildId })
      .from(subscribers)
      .where(eq(subscribers.channelId, channelId))
      .limit(1);

    if (subscriber === undefined) {
      return;
    }

    await this.db
      .delete(subscribers)
      .where(eq(subscribers.channelId, channelId));
    await Promise.all([
      this.env.YOUTUBE_SUBSCRIPTIONS_INDEX.delete(
        guildSubscriptionKey(subscriber.guildId, channelId, youtubeChannelId),
      ),
      this.env.YOUTUBE_SUBSCRIPTIONS_INDEX.delete(
        channelSubscriptionKey(channelId, youtubeChannelId),
      ),
    ]);

    await this.ensureWebSubUnsubscribed();
  }

  /** Confirms a pending WebSub subscription or unsubscription. */
  async confirmWebSubIntent(
    mode: WebSubMode,
    topic: string,
    leaseSeconds?: number,
  ): Promise<boolean> {
    const youtubeChannelId = this.requireYouTubeChannelId();
    if (topic !== createYouTubeTopicUrl(youtubeChannelId)) {
      return false;
    }

    const state = await this.readWebSubState();
    const expectedStatus =
      mode === 'subscribe' ? 'subscribing' : 'unsubscribing';
    if (state.status !== expectedStatus || state.secret === undefined) {
      return false;
    }

    if (mode === 'unsubscribe') {
      await this.clearWebSubState();
      return true;
    }

    if (
      leaseSeconds === undefined ||
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds <= 0
    ) {
      return false;
    }

    const renewalDelayMs = Math.floor(
      leaseSeconds * 1000 * WEBSUB_RENEWAL_FRACTION,
    );
    if (!Number.isSafeInteger(renewalDelayMs)) {
      return false;
    }

    await Promise.all([
      this.ctx.storage.put(WEBSUB_STATUS_KEY, 'subscribed'),
      this.ctx.storage.setAlarm(Date.now() + renewalDelayMs),
    ]);
    return true;
  }

  /** Records that the hub denied the current WebSub intent. */
  async denyWebSubIntent(topic: string, reason?: string): Promise<boolean> {
    const youtubeChannelId = this.requireYouTubeChannelId();
    if (topic !== createYouTubeTopicUrl(youtubeChannelId)) {
      return false;
    }

    const state = await this.readWebSubState();
    if (state.status === undefined) {
      return false;
    }

    await this.clearWebSubState();
    console.warn(
      JSON.stringify({
        event: 'youtube_websub_denied',
        youtubeChannelId,
        reason,
      }),
    );
    return true;
  }

  /** Authenticates and records a WebSub content notification. */
  async receiveWebSubNotification(
    body: ArrayBuffer,
    signatureHeader: string | null,
  ): Promise<boolean> {
    const state = await this.readWebSubState();
    if (state.secret === undefined) {
      return false;
    }

    const valid = await verifyYouTubeWebSubSignature(
      body,
      signatureHeader,
      state.secret,
    );
    if (!valid) {
      return false;
    }

    const notifications = parseYouTubeVideoNotifications(
      new TextDecoder().decode(body),
    );
    for (const notification of notifications) {
      await this.recordVideo(notification);
    }

    return true;
  }

  /** Renews or reconciles the WebSub subscription when its alarm fires. */
  async alarm(): Promise<void> {
    const subscriberCount = await this.getSubscriberCount();
    const state = await this.readWebSubState();

    try {
      if (subscriberCount > 0) {
        await this.requestWebSub('subscribe', state.secret ?? createSecret());
      } else if (state.secret !== undefined) {
        await this.requestWebSub('unsubscribe', state.secret);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'youtube_websub_alarm_failed',
          youtubeChannelId: this.requireYouTubeChannelId(),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** Claims a new video and queues notifications for all subscribers. */
  async recordVideo(notification: YouTubeVideoNotification): Promise<void> {
    const publishedAt = this.validateAndParseNotification(notification);
    const [claim] = await this.db
      .insert(videos)
      .values({
        id: notification.videoId,
        title: notification.title,
        publishedAt,
      })
      .onConflictDoNothing({ target: videos.id })
      .returning({ id: videos.id });

    if (claim === undefined) {
      return;
    }

    try {
      const subscriberRows = await this.db.select().from(subscribers);
      const deliveries = await Promise.all(
        subscriberRows.map((subscriber) =>
          createYouTubeDiscordMessage(notification, subscriber),
        ),
      );

      await enqueueDiscordMessages(this.env.DISCORD_MESSAGES, deliveries);
    } catch (error) {
      await this.db.delete(videos).where(eq(videos.id, notification.videoId));
      throw error;
    }
  }

  private validateAndParseNotification(
    notification: YouTubeVideoNotification,
  ): Date {
    requireNonEmpty(notification.videoId, 'YouTube video ID');
    requireNonEmpty(notification.channelId, 'YouTube channel ID');
    requireNonEmpty(notification.title, 'YouTube video title');
    requireNonEmpty(notification.publishedAt, 'YouTube published timestamp');

    const objectName = this.requireYouTubeChannelId();

    if (notification.channelId !== objectName) {
      throw new Error(
        `YouTube channel ID ${notification.channelId} does not match Durable Object ${objectName}`,
      );
    }

    const publishedAt = new Date(notification.publishedAt);
    if (Number.isNaN(publishedAt.getTime())) {
      throw new Error('YouTube published timestamp must be a valid date');
    }

    return publishedAt;
  }

  private async ensureWebSubSubscribed(): Promise<void> {
    if ((await this.getSubscriberCount()) === 0) {
      return;
    }

    const state = await this.readWebSubState();
    if (state.status === 'subscribing' || state.status === 'subscribed') {
      return;
    }

    await this.requestWebSub('subscribe', state.secret ?? createSecret());
  }

  private async ensureWebSubUnsubscribed(): Promise<void> {
    if ((await this.getSubscriberCount()) > 0) {
      return;
    }

    const state = await this.readWebSubState();
    if (state.secret === undefined || state.status === 'unsubscribing') {
      return;
    }

    await this.requestWebSub('unsubscribe', state.secret);
  }

  private async requestWebSub(mode: WebSubMode, secret: string): Promise<void> {
    const status = mode === 'subscribe' ? 'subscribing' : 'unsubscribing';
    await Promise.all([
      this.ctx.storage.put({
        [WEBSUB_SECRET_KEY]: secret,
        [WEBSUB_STATUS_KEY]: status,
      }),
      this.ctx.storage.setAlarm(Date.now() + WEBSUB_RETRY_DELAY_MS),
    ]);

    const response = await fetch(
      createYouTubeWebSubRequest({
        mode,
        channelId: this.requireYouTubeChannelId(),
        publicBaseUrl: this.env.PUBLIC_BASE_URL,
        secret,
      }),
    );
    if (response.ok) {
      return;
    }

    if (response.body !== null) {
      await response.body.cancel();
    }
    throw new Error(`YouTube WebSub hub returned HTTP ${response.status}`);
  }

  private async readWebSubState(): Promise<WebSubState> {
    const values = await this.ctx.storage.get<string>([
      WEBSUB_SECRET_KEY,
      WEBSUB_STATUS_KEY,
    ]);
    const secret = values.get(WEBSUB_SECRET_KEY);
    const status = values.get(WEBSUB_STATUS_KEY);

    if (status !== undefined && !isWebSubStatus(status)) {
      throw new Error('YouTube WebSub status is invalid');
    }
    if ((secret === undefined) !== (status === undefined)) {
      throw new Error('YouTube WebSub state is incomplete');
    }

    return { secret, status };
  }

  private async clearWebSubState(): Promise<void> {
    await Promise.all([
      this.ctx.storage.delete([WEBSUB_SECRET_KEY, WEBSUB_STATUS_KEY]),
      this.ctx.storage.deleteAlarm(),
    ]);
  }

  private async getSubscriberCount(): Promise<number> {
    const [result] = await this.db
      .select({ subscriberCount: count() })
      .from(subscribers);
    return result?.subscriberCount ?? 0;
  }

  private requireYouTubeChannelId(): string {
    const objectName = this.ctx.id.name;
    if (objectName === undefined) {
      throw new Error('YouTubeSubscription requires a named Durable Object');
    }

    return objectName;
  }
}

function isWebSubStatus(value: string): value is WebSubStatus {
  return (
    value === 'subscribing' ||
    value === 'subscribed' ||
    value === 'unsubscribing'
  );
}

function createSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function validateSubscriberRegistration(
  registration: YouTubeSubscriberRegistration,
): void {
  if (typeof registration !== 'object' || registration === null) {
    throw new Error('YouTube subscriber registration must be an object');
  }

  requireDiscordSnowflake(registration.guildId, 'Discord guild ID');
  requireDiscordSnowflake(registration.channelId, 'Discord channel ID');

  if (registration.message !== undefined) {
    requireNonEmpty(registration.message, 'Subscriber message');
  }

  if (
    registration.ping !== undefined &&
    registration.ping !== 'everyone' &&
    registration.ping !== 'here'
  ) {
    requireDiscordSnowflake(registration.ping, 'Discord role ID');
  }
}

function requireDiscordSnowflake(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== 'string' || !DISCORD_SNOWFLAKE.test(value)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
}

function requireNonEmpty(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} cannot be empty`);
  }
}
