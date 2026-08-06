import { DurableObject } from 'cloudflare:workers';

import { createYouTubeWebSubRequest } from '../youtube/websub';

const SUBSCRIPTION_KEY = 'subscription';

export interface SubscriptionState {
  schemaVersion: 1;
  phase: 'uninitialized' | 'pending';
  channelId: string;
  createdAtMs: number;
  requestedAtMs: number | null;
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
    };

    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, created);
    return created;
  }

  async requestSubscription(): Promise<SubscriptionState> {
    const state = this.ensureInitialized(this.env.YOUTUBE_CHANNEL_ID);

    if (state.phase === 'pending') {
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

    const pending: SubscriptionState = {
      ...state,
      phase: 'pending',
      requestedAtMs: Date.now(),
    };

    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, pending);

    return pending;
  }
}
