import { DurableObject } from 'cloudflare:workers';
import { count, eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as z from 'zod';

import migrations from '../db/youtube-subscription/migrations/migrations.js';
import { subscribers, videos } from '../db/youtube-subscription/schema';
import { DiscordMentionTarget } from '../discord/message';
import { DiscordSnowflake } from '../discord/snowflake';
import { toLoggableError } from '../log';
import { enqueueDiscordMessages } from '../queue/discord-message';
import type { YouTubeVideoDelivery } from '../queue/subscription-event';
import { YouTubeChannelId, YouTubeWebSubSecret } from '../youtube/data';
import {
  parseYouTubeVideoNotifications,
  YouTubeVideoNotification,
} from '../youtube/notification';
import {
  createYouTubeTopicUrl,
  createYouTubeWebSubRequest,
  WebSubLeaseSeconds,
  WebSubMode,
  verifyYouTubeWebSubSignature,
} from '../youtube/websub';
import { createYouTubeDelivery } from './discord-message';
import {
  createChannelYouTubeSubscriptionKey,
  createGuildYouTubeSubscriptionKey,
  type YouTubeSubscriptionMetadata,
} from './index';

const SUBSCRIPTION_INDEX_VALUE = '1';
const WEBSUB_SECRET_KEY = 'websub:secret';
const WEBSUB_STATUS_KEY = 'websub:status';
const WEBSUB_RETRY_DELAY_MS = 5 * 60 * 1000;
const WEBSUB_RENEWAL_FRACTION = 0.8;

const WebSubStatus = z.enum(['subscribing', 'subscribed', 'unsubscribing']);
type WebSubStatus = z.infer<typeof WebSubStatus>;

const WebSubState = z
  .object({
    secret: YouTubeWebSubSecret.optional(),
    status: WebSubStatus.optional(),
  })
  .refine(
    ({ secret, status }) => (secret === undefined) === (status === undefined),
  );
type WebSubState = z.infer<typeof WebSubState>;

export const YouTubeSubscriberRegistration = z.object({
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  channelTitle: z.string().trim().min(1),
  message: z.string().trim().min(1).optional(),
  ping: DiscordMentionTarget.optional(),
});

export type YouTubeSubscriberRegistration = z.infer<
  typeof YouTubeSubscriberRegistration
>;
type YouTubeSubscriberRegistrationInput = z.input<
  typeof YouTubeSubscriberRegistration
>;

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
    registration: YouTubeSubscriberRegistrationInput,
  ): Promise<void> {
    const validated = YouTubeSubscriberRegistration.parse(registration);
    const youtubeChannelId = this.requireYouTubeChannelId();
    const [subscriber] = await this.db
      .insert(subscribers)
      .values({
        guildId: validated.guildId,
        channelId: validated.channelId,
        message: validated.message ?? null,
        ping: validated.ping ?? null,
      })
      .onConflictDoUpdate({
        target: subscribers.channelId,
        set: {
          message: validated.message ?? null,
          ping: validated.ping ?? null,
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

    const metadata: YouTubeSubscriptionMetadata = {
      title: validated.channelTitle,
    };
    await Promise.all([
      this.env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
        createGuildYouTubeSubscriptionKey(
          subscriber.guildId,
          subscriber.channelId,
          youtubeChannelId,
        ),
        SUBSCRIPTION_INDEX_VALUE,
        { metadata },
      ),
      this.env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
        createChannelYouTubeSubscriptionKey(
          subscriber.channelId,
          youtubeChannelId,
        ),
        SUBSCRIPTION_INDEX_VALUE,
      ),
    ]);

    await this.ensureWebSubSubscribed();
  }

  /** Removes a Discord subscriber and its global lookup indexes. */
  async removeSubscriber(channelId: string): Promise<void> {
    const validatedChannelId = DiscordSnowflake.parse(channelId);
    const youtubeChannelId = this.requireYouTubeChannelId();
    const [subscriber] = await this.db
      .select({ guildId: subscribers.guildId })
      .from(subscribers)
      .where(eq(subscribers.channelId, validatedChannelId))
      .limit(1);

    if (subscriber === undefined) {
      return;
    }

    await this.db
      .delete(subscribers)
      .where(eq(subscribers.channelId, validatedChannelId));
    await Promise.all([
      this.env.YOUTUBE_SUBSCRIPTIONS_INDEX.delete(
        createGuildYouTubeSubscriptionKey(
          subscriber.guildId,
          validatedChannelId,
          youtubeChannelId,
        ),
      ),
      this.env.YOUTUBE_SUBSCRIPTIONS_INDEX.delete(
        createChannelYouTubeSubscriptionKey(
          validatedChannelId,
          youtubeChannelId,
        ),
      ),
    ]);

    await this.ensureWebSubUnsubscribed();
  }

  /** Confirms a pending WebSub subscription or unsubscription. */
  async confirmWebSubIntent(
    mode: z.input<typeof WebSubMode>,
    topic: string,
    leaseSeconds?: number,
  ): Promise<boolean> {
    const validatedMode = WebSubMode.parse(mode);
    const youtubeChannelId = this.requireYouTubeChannelId();
    if (topic !== createYouTubeTopicUrl(youtubeChannelId)) {
      return false;
    }

    const state = await this.readWebSubState();
    const expectedStatus =
      validatedMode === 'subscribe' ? 'subscribing' : 'unsubscribing';
    if (state.status !== expectedStatus || state.secret === undefined) {
      return false;
    }

    if (validatedMode === 'unsubscribe') {
      await this.clearWebSubState();
      return true;
    }

    const validatedLeaseSeconds = WebSubLeaseSeconds.safeParse(leaseSeconds);
    if (!validatedLeaseSeconds.success) {
      return false;
    }

    const renewalDelayMs = Math.floor(
      validatedLeaseSeconds.data * 1000 * WEBSUB_RENEWAL_FRACTION,
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
    console.warn({
      event: 'youtube_websub_denied',
      youtubeChannelId,
      reason,
    });
    return true;
  }

  /** Authenticates and durably queues a WebSub content notification. */
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
    if (notifications.length !== 0) {
      await this.env.SUBSCRIPTION_EVENTS.sendBatch(
        notifications.map((notification) => {
          const delivery: YouTubeVideoDelivery = {
            kind: 'youtube-video',
            channelId: notification.channelId,
            notification,
          };
          return { body: delivery };
        }),
      );
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
      console.error({
        event: 'youtube_websub_alarm_failed',
        youtubeChannelId: this.requireYouTubeChannelId(),
        error: toLoggableError(error),
      });
    }
  }

  /** Claims a new video and queues notifications for all subscribers. */
  async recordVideo(
    notification: z.input<typeof YouTubeVideoNotification>,
  ): Promise<void> {
    const validated = YouTubeVideoNotification.parse(notification);
    const youtubeChannelId = this.requireYouTubeChannelId();
    if (validated.channelId !== youtubeChannelId) {
      throw new Error(
        `YouTube channel ID ${validated.channelId} does not match Durable Object ${youtubeChannelId}`,
      );
    }
    const publishedAt = new Date(validated.publishedAt);
    const [claim] = await this.db
      .insert(videos)
      .values({
        id: validated.videoId,
        title: validated.title,
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
          createYouTubeDelivery(validated, subscriber),
        ),
      );

      await enqueueDiscordMessages(this.env.DISCORD_MESSAGES, deliveries);
    } catch (error) {
      await this.db.delete(videos).where(eq(videos.id, validated.videoId));
      throw error;
    }
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

  private async requestWebSub(
    mode: WebSubMode,
    secret: YouTubeWebSubSecret,
  ): Promise<void> {
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
    const values = await this.ctx.storage.get<unknown>([
      WEBSUB_SECRET_KEY,
      WEBSUB_STATUS_KEY,
    ]);
    return WebSubState.parse({
      secret: values.get(WEBSUB_SECRET_KEY),
      status: values.get(WEBSUB_STATUS_KEY),
    });
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

  private requireYouTubeChannelId(): YouTubeChannelId {
    const objectName = this.ctx.id.name;
    if (objectName === undefined) {
      throw new Error('YouTubeSubscription requires a named Durable Object');
    }

    return YouTubeChannelId.parse(objectName);
  }
}

function createSecret(): YouTubeWebSubSecret {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return YouTubeWebSubSecret.parse(
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  );
}
