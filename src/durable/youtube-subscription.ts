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

    const response = await fetch(request);

    if (!response.ok) {
      const responseBody = await response.text();

      throw new Error(
        `YouTube WebSub hub rejected the subscription with HTTP ${response.status}: ${responseBody}`,
      );
    }

    await response.body?.cancel();

    const awaitingVerification: SubscriptionState = {
      ...state,
      phase: state.phase === 'uninitialized' ? 'pending' : state.phase,
      requestedAtMs: Date.now(),
    };

    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, awaitingVerification);

    return awaitingVerification;
  }

  confirmSubscription(topic: string, leaseSeconds: number): SubscriptionState {
    const state = this.ctx.storage.kv.get<SubscriptionState>(SUBSCRIPTION_KEY);

    if (state === undefined) {
      throw new Error('Subscription is not initialized');
    }

    if (state.requestedAtMs === null) {
      throw new Error('No subscription verification is pending');
    }

    const expectedTopic = createYouTubeTopicUrl(state.channelId);

    if (topic !== expectedTopic) {
      throw new Error('WebSub verification topic does not match');
    }

    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
      throw new Error('WebSub lease must be a positive integer');
    }

    const expiresAtMs = Date.now() + leaseSeconds * 1000;

    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new Error('WebSub lease expiration is outside the supported range');
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
