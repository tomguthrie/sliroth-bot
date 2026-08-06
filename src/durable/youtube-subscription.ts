import { DurableObject } from 'cloudflare:workers';

import {
  createYouTubeTopicUrl,
  createYouTubeWebSubRequest,
} from '../youtube/websub';

import type { YouTubeVideoNotification } from '../youtube/notification';

const SUBSCRIPTION_KEY = 'subscription';
const VERIFICATION_TIMEOUT_MS = 30 * 60 * 1000;
const RENEWAL_FRACTION = 0.8;
const VIDEO_KEY_PREFIX = 'video:';

export interface SubscriptionState {
  schemaVersion: 1;
  phase: 'uninitialized' | 'pending' | 'active';
  channelId: string;
  createdAtMs: number;
  requestedAtMs: number | null;
  renewsAtMs: number | null;
  expiresAtMs: number | null;
}

export interface StoredVideo {
  schemaVersion: 1;
  notification: YouTubeVideoNotification;
  status: 'baseline' | 'pending';
  firstSeenAtMs: number;
}

export class YouTubeSubscription extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  ensureInitialized(channelId: string): SubscriptionState {
    if (channelId.trim() === '') {
      throw new Error('YouTube channel ID cannot be empty');
    }

    const existing =
      this.ctx.storage.kv.get<SubscriptionState>(SUBSCRIPTION_KEY);

    if (existing !== undefined) {
      if (existing.channelId !== channelId) {
        throw new Error(
          'Subscription was initialized for a different YouTube channel',
        );
      }

      return existing;
    }

    const created: SubscriptionState = {
      schemaVersion: 1,
      phase: 'uninitialized',
      channelId,
      createdAtMs: Date.now(),
      requestedAtMs: null,
      renewsAtMs: null,
      expiresAtMs: null,
    };

    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, created);
    return created;
  }

  async reconcileSubscription(): Promise<SubscriptionState> {
    let state = this.ensureInitialized(this.env.YOUTUBE_CHANNEL_ID);
    const nowMs = Date.now();

    if (state.requestedAtMs !== null) {
      const retryAtMs = state.requestedAtMs + VERIFICATION_TIMEOUT_MS;

      if (nowMs < retryAtMs) {
        return state;
      }

      state = {
        ...state,
        requestedAtMs: null,
      };

      this.ctx.storage.kv.put(SUBSCRIPTION_KEY, state);
    }

    if (
      state.phase === 'active' &&
      state.renewsAtMs !== null &&
      nowMs < state.renewsAtMs
    ) {
      return state;
    }

    return this.requestSubscription();
  }

  async requestSubscription(): Promise<SubscriptionState> {
    const state = this.ensureInitialized(this.env.YOUTUBE_CHANNEL_ID);

    if (state.requestedAtMs !== null) {
      return state;
    }

    const request = createYouTubeWebSubRequest({
      mode: 'subscribe',
      channelId: state.channelId,
      publicBaseUrl: this.env.PUBLIC_BASE_URL,
      callbackToken: this.env.YOUTUBE_CALLBACK_TOKEN,
      secret: this.env.YOUTUBE_WEBSUB_SECRET,
    });

    const requestedAtMs = Date.now();

    const awaitingVerification: SubscriptionState = {
      ...state,
      phase: state.phase === 'uninitialized' ? 'pending' : state.phase,
      requestedAtMs,
    };

    // Persist before fetch so an immediate verification callback can succeed.
    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, awaitingVerification);

    try {
      const response = await fetch(request);

      if (!response.ok) {
        const responseBody = await response.text();

        throw new Error(
          `YouTube WebSub hub rejected the subscription with HTTP ${response.status}: ${responseBody}`,
        );
      }

      await response.body?.cancel();
    } catch (error) {
      this.restoreAfterFailedRequest(requestedAtMs, state);
      throw error;
    }

    // Verification may have completed while fetch() was awaiting.
    const current =
      this.ctx.storage.kv.get<SubscriptionState>(SUBSCRIPTION_KEY);

    return current ?? awaitingVerification;
  }

  private restoreAfterFailedRequest(
    requestedAtMs: number,
    previous: SubscriptionState,
  ): void {
    const current =
      this.ctx.storage.kv.get<SubscriptionState>(SUBSCRIPTION_KEY);

    if (current === undefined) {
      return;
    }

    if (current.requestedAtMs !== requestedAtMs) {
      return;
    }

    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, previous);
  }

  confirmSubscription(
    topic: string,
    leaseSeconds: number,
  ): SubscriptionState | null {
    const state = this.ctx.storage.kv.get<SubscriptionState>(SUBSCRIPTION_KEY);

    if (state === undefined) {
      return null;
    }

    if (state.requestedAtMs === null) {
      return null;
    }

    const expectedTopic = createYouTubeTopicUrl(state.channelId);

    if (topic !== expectedTopic) {
      return null;
    }

    const nowMs = Date.now();
    const leaseDurationMs = leaseSeconds * 1000;

    if (!Number.isSafeInteger(leaseDurationMs)) {
      return null;
    }

    const renewsAtMs = nowMs + leaseDurationMs * RENEWAL_FRACTION;
    const expiresAtMs = nowMs + leaseDurationMs;

    if (
      !Number.isSafeInteger(renewsAtMs) ||
      !Number.isSafeInteger(expiresAtMs)
    ) {
      return null;
    }

    const active: SubscriptionState = {
      ...state,
      phase: 'active',
      requestedAtMs: null,
      renewsAtMs,
      expiresAtMs,
    };

    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, active);

    return active;
  }

  recordNotifications(
    notifications: YouTubeVideoNotification[],
  ): YouTubeVideoNotification[] {
    const subscription = this.ensureInitialized(this.env.YOUTUBE_CHANNEL_ID);
    const uniqueNotifications = new Map<
      string,
      { notification: YouTubeVideoNotification; publishedAtMs: number }
    >();

    for (const notification of notifications) {
      if (notification.channelId !== subscription.channelId) {
        throw new Error('YouTube notification belongs to a different channel');
      }

      const publishedAtMs = Date.parse(notification.publishedAt);

      if (!Number.isFinite(publishedAtMs)) {
        throw new Error('YouTube notification has an invalid published date');
      }

      if (!uniqueNotifications.has(notification.videoId)) {
        uniqueNotifications.set(notification.videoId, {
          notification,
          publishedAtMs,
        });
      }
    }

    const firstSeenAtMs = Date.now();
    const pending: YouTubeVideoNotification[] = [];

    for (const {
      notification,
      publishedAtMs,
    } of uniqueNotifications.values()) {
      const storageKey = createVideoStorageKey(notification.videoId);
      const existing = this.ctx.storage.kv.get<StoredVideo>(storageKey);

      if (existing !== undefined) {
        continue;
      }

      const status =
        publishedAtMs < subscription.createdAtMs ? 'baseline' : 'pending';

      const stored: StoredVideo = {
        schemaVersion: 1,
        notification,
        status,
        firstSeenAtMs,
      };

      this.ctx.storage.kv.put(storageKey, stored);

      if (status === 'pending') {
        pending.push(notification);
      }
    }

    return pending;
  }
}

function createVideoStorageKey(videoId: string): string {
  return `${VIDEO_KEY_PREFIX}${videoId}`;
}
