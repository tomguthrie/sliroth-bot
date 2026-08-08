import { DurableObject } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
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
import type { YouTubeVideoNotification } from '../youtube/notification';
import { createYouTubeDiscordMessage } from './discord-message';

const SUBSCRIPTION_INDEX_VALUE = '1';
const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;

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

  private requireYouTubeChannelId(): string {
    const objectName = this.ctx.id.name;
    if (objectName === undefined) {
      throw new Error('YouTubeSubscription requires a named Durable Object');
    }

    return objectName;
  }
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

function guildSubscriptionKey(
  guildId: string,
  channelId: string,
  youtubeChannelId: string,
): string {
  return `guild:${guildId}:channel:${channelId}:youtube:${youtubeChannelId}`;
}

function channelSubscriptionKey(
  channelId: string,
  youtubeChannelId: string,
): string {
  return `channel:${channelId}:youtube:${youtubeChannelId}`;
}

function requireNonEmpty(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} cannot be empty`);
  }
}
