import { DurableObject } from 'cloudflare:workers';

import {
  createYouTubeTopicUrl,
  createYouTubeWebSubRequest,
} from '../youtube/websub';

const SUBSCRIPTION_KEY = 'subscription';

export interface SubscriptionState {
  schemaVersion: 1;
  phase: 'uninitialized' | 'pending' | 'active';
  channelId: string;
  createdAtMs: number;
  requestedAtMs: number | null;
  expiresAtMs: number | null;
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
      expiresAtMs: null,
    };

    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, created);
    return created;
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

    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
      return null;
    }

    const expiresAtMs = Date.now() + leaseSeconds * 1000;

    if (!Number.isSafeInteger(expiresAtMs)) {
      return null;
    }

    const active: SubscriptionState = {
      ...state,
      phase: 'active',
      requestedAtMs: null,
      expiresAtMs,
    };

    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, active);

    return active;
  }
}
