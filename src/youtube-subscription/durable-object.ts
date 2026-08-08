import { DurableObject } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import migrations from '../db/youtube-subscription/migrations/migrations.js';
import { subscribers, videos } from '../db/youtube-subscription/schema';
import { enqueueDiscordMessages } from '../queue/discord-message';
import type { YouTubeVideoNotification } from '../youtube/notification';
import { createYouTubeDiscordMessage } from './discord-message';

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

    const objectName = this.ctx.id.name;
    if (objectName === undefined) {
      throw new Error('YouTubeSubscription requires a named Durable Object');
    }

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
}

function requireNonEmpty(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} cannot be empty`);
  }
}
