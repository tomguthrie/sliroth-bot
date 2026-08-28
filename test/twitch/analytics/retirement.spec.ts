import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  analyticsAuthorization,
  analyticsOauthStates,
  analyticsPendingFinalizers,
  analyticsRuntime,
  eventSubSubscriptions,
  twitchSubscribers,
} from '../../../src/db/twitch-subscription/schema';
import { TwitchAnalyticsService } from '../../../src/twitch/analytics/service';
import type { TwitchEventSubDelivery } from '../../../src/twitch/subscription/queue';

const CHANNEL_ID = '123456789012345678';
const ONLINE_SUBSCRIPTION_ID = 'subscription-stream-online';
const ANALYTICS_SUBSCRIPTION_ID = 'subscription-chat-message';

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.TOKEN_STORE.put('twitch', 'app-access-token');
});

describe('Twitch analytics retirement', () => {
  it('cancels scheduled collection without sampling', async () => {
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const alarm = await runInDurableObject(
      subscription,
      async (instance, state) => {
        await state.storage.setAlarm(Date.now() + 60_000);
        await instance.alarm();
        return state.storage.getAlarm();
      },
    );

    expect(alarm).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tears down all analytics state on the next stream start', async () => {
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );
    await seedAnalyticsState(subscription);
    const requests = mockTwitchTeardown({ expiredAccessToken: true });

    await subscription.processEventSubMessage(onlineDelivery());
    await subscription.processEventSubMessage(onlineDelivery());

    expect(
      requests
        .filter(
          ({ method, pathname }) =>
            method === 'DELETE' && pathname === '/helix/eventsub/subscriptions',
        )
        .map(({ subscriptionId }) => subscriptionId),
    ).toEqual([ONLINE_SUBSCRIPTION_ID, ANALYTICS_SUBSCRIPTION_ID]);
    expect(
      requests
        .filter(({ pathname }) => pathname === '/oauth2/revoke')
        .map(({ token }) => token),
    ).toEqual(['user-access-token', 'refreshed-access-token']);

    const stored = await runInDurableObject(
      subscription,
      async (_instance, state) => {
        const database = drizzle(state.storage);
        return {
          subscriptions: await database.select().from(eventSubSubscriptions),
          authorization: await database.select().from(analyticsAuthorization),
          runtime: await database.select().from(analyticsRuntime),
          oauthStates: await database.select().from(analyticsOauthStates),
          finalizers: await database.select().from(analyticsPendingFinalizers),
          alarm: await state.storage.getAlarm(),
        };
      },
    );
    expect(stored).toEqual({
      subscriptions: [],
      authorization: [],
      runtime: [],
      oauthStates: [],
      finalizers: [],
      alarm: null,
    });
  });

  it('preserves shared lifecycle subscriptions for Discord subscribers', async () => {
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );
    await seedAnalyticsState(subscription, true);
    const requests = mockTwitchTeardown();

    await runInDurableObject(subscription, async (_instance, state) => {
      const retirement = new TwitchAnalyticsService(
        state,
        env,
        drizzle(state.storage),
      );
      await retirement.processEventSub(onlineDelivery());
    });

    expect(
      requests
        .filter(({ method }) => method === 'DELETE')
        .map(({ subscriptionId }) => subscriptionId),
    ).toEqual([ANALYTICS_SUBSCRIPTION_ID]);
    const storedSubscriptions = await runInDurableObject(
      subscription,
      async (_instance, state) =>
        drizzle(state.storage).select().from(eventSubSubscriptions),
    );
    expect(storedSubscriptions).toHaveLength(1);
    expect(storedSubscriptions[0]?.subscriptionKey).toBe('stream.online');
  });
});

async function seedAnalyticsState(
  subscription: DurableObjectStub,
  withSubscriber = false,
): Promise<void> {
  await runInDurableObject(subscription, async (_instance, state) => {
    const database = drizzle(state.storage);
    const now = new Date();
    await database.insert(analyticsAuthorization).values({
      singleton: 1,
      accessToken: 'user-access-token',
      refreshToken: 'user-refresh-token',
      scopesJson: '[]',
      authorizedAt: now,
      validatedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    await database.insert(analyticsRuntime).values({
      singleton: 1,
      status: 'active',
      enabledAt: now,
      nextTokenValidationAt: now,
      nextEventSubAuditAt: now,
    });
    await database.insert(analyticsOauthStates).values({
      stateHash: 'state-hash',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await database.insert(analyticsPendingFinalizers).values({
      streamId: 'old-stream',
      finalizeAfter: now,
    });
    await database.insert(eventSubSubscriptions).values([
      {
        subscriptionKey: 'stream.online',
        type: 'stream.online',
        version: '1',
        conditionJson: JSON.stringify({ broadcaster_user_id: CHANNEL_ID }),
        subscriptionId: ONLINE_SUBSCRIPTION_ID,
      },
      {
        subscriptionKey: 'analytics:chat-message',
        type: 'channel.chat.message',
        version: '1',
        conditionJson: JSON.stringify({
          broadcaster_user_id: CHANNEL_ID,
          user_id: CHANNEL_ID,
        }),
        subscriptionId: ANALYTICS_SUBSCRIPTION_ID,
      },
    ]);
    if (withSubscriber) {
      await database.insert(twitchSubscribers).values({
        channelId: '345678901234567890',
        guildId: '234567890123456789',
      });
    }
    await state.storage.setAlarm(Date.now() + 60_000);
  });
}

function onlineDelivery(): TwitchEventSubDelivery {
  return {
    kind: 'twitch-eventsub',
    messageId: 'next-stream-online',
    timestamp: '2026-08-28T19:00:00.000Z',
    message: {
      messageType: 'notification',
      eventType: 'stream.online',
      subscription: {
        id: ONLINE_SUBSCRIPTION_ID,
        type: 'stream.online',
        version: '1',
        broadcasterId: CHANNEL_ID,
      },
      event: {
        streamId: 'next-stream',
        broadcasterId: CHANNEL_ID,
        broadcasterLogin: 'sliroth',
        broadcasterName: 'Sliroth',
        startedAt: '2026-08-28T19:00:00.000Z',
      },
    },
  };
}

interface TeardownRequest {
  readonly method: string;
  readonly pathname: string;
  readonly subscriptionId?: string;
  readonly token?: string;
}

function mockTwitchTeardown(
  options: { readonly expiredAccessToken?: boolean } = {},
): TeardownRequest[] {
  const requests: TeardownRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const form = request.headers
      .get('content-type')
      ?.startsWith('application/x-www-form-urlencoded')
      ? await request.clone().formData()
      : undefined;
    const subscriptionId = url.searchParams.get('id');
    const formToken = form?.get('token');
    const token = typeof formToken === 'string' ? formToken : null;
    const recorded: TeardownRequest = {
      method: request.method,
      pathname: url.pathname,
      ...(subscriptionId === null ? {} : { subscriptionId }),
      ...(token === null ? {} : { token }),
    };
    requests.push(recorded);

    if (url.pathname === '/helix/eventsub/subscriptions') {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/oauth2/revoke') {
      if (
        options.expiredAccessToken === true &&
        token === 'user-access-token'
      ) {
        return new Response(null, { status: 400 });
      }
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/oauth2/token') {
      return Response.json({
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
        expires_in: 3600,
        scope: [],
      });
    }
    throw new Error(
      `Unexpected Twitch request: ${request.method} ${url.toString()}`,
    );
  });
  return requests;
}
