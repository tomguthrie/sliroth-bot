import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { eventSubSubscriptions } from '../../src/db/twitch-subscription/schema';
import { handleTwitchEventSub } from '../../src/twitch/eventsub-handler';
import type { TwitchSubscription } from '../../src/twitch-subscription/durable-object';
import {
  createChannelTwitchSubscriptionKey,
  createGuildTwitchSubscriptionKey,
} from '../../src/twitch-subscription/index';

const BROADCASTER_ID = '123456789012345678';
const WEBHOOK_BROADCASTER_ID = '123456789012345679';
const RECONCILE_BROADCASTER_ID = '123456789012345680';
const GUILD_ID = '234567890123456789';
const CHANNEL_ID = '345678901234567890';

beforeEach(async () => {
  await env.TOKEN_STORE.delete('twitch');
});

describe('TwitchSubscription EventSub reconciliation', () => {
  it('rejects invalid broadcaster data before changing storage', async () => {
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      `broadcaster-${crypto.randomUUID()}`,
    );

    await expect(
      runInDurableObject(subscription, (instance: TwitchSubscription) =>
        instance.addSubscriber(
          {
            id: BROADCASTER_ID,
            login: 'sliroth',
            displayName: '   ',
            profileImageUrl: 'https://example.com/profile.png',
            offlineImageUrl: 'https://example.com/offline.png',
          },
          { guildId: GUILD_ID, channelId: CHANNEL_ID },
        ),
      ),
    ).rejects.toThrow();
  });
  it('creates desired subscriptions and deletes them with the last subscriber', async () => {
    const requests: { method: string; url: string; eventType?: string }[] = [];
    let sequence = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith('https://id.twitch.tv/oauth2/token')) {
        requests.push({ method: request.method, url: request.url });
        return Response.json({ access_token: 'token', expires_in: 3600 });
      }
      if (request.method === 'POST') {
        const body = await request.json<{
          type: string;
          version: string;
          condition: Record<string, string>;
          transport: { method: string; callback: string };
        }>();
        requests.push({
          method: request.method,
          url: request.url,
          eventType: body.type,
        });
        sequence += 1;
        return Response.json({
          data: [
            {
              id: `subscription-${sequence}`,
              status: 'webhook_callback_verification_pending',
              type: body.type,
              version: body.version,
              condition: body.condition,
              created_at: '2026-08-09T00:00:00Z',
              transport: body.transport,
              cost: 1,
            },
          ],
        });
      }
      if (request.method === 'DELETE') {
        requests.push({ method: request.method, url: request.url });
        return new Response(null, { status: 204 });
      }
      throw new Error(
        `Unexpected Twitch request: ${request.method} ${request.url}`,
      );
    });

    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(BROADCASTER_ID);
    await subscription.addSubscriber(
      {
        id: BROADCASTER_ID,
        login: 'sliroth',
        displayName: 'Sliroth',
        profileImageUrl: 'https://example.com/profile.png',
        offlineImageUrl: 'https://example.com/offline.png',
      },
      { guildId: GUILD_ID, channelId: CHANNEL_ID },
    );

    expect(
      requests
        .filter(
          ({ method, url }) => method === 'POST' && url.includes('/helix/'),
        )
        .map(({ eventType }) => eventType)
        .sort(),
    ).toEqual(['stream.offline', 'stream.online']);
    await expect(
      env.TWITCH_SUBSCRIPTIONS_INDEX.getWithMetadata(
        createGuildTwitchSubscriptionKey(GUILD_ID, CHANNEL_ID, BROADCASTER_ID),
      ),
    ).resolves.toMatchObject({
      value: '1',
      metadata: { login: 'sliroth', displayName: 'Sliroth' },
    });
    await expect(
      env.TWITCH_SUBSCRIPTIONS_INDEX.getWithMetadata(
        createChannelTwitchSubscriptionKey(CHANNEL_ID, BROADCASTER_ID),
      ),
    ).resolves.toMatchObject({ value: '1', metadata: null });

    await expect(subscription.removeSubscriber(CHANNEL_ID)).resolves.toBe(true);
    expect(
      requests.filter((request) => request.method === 'DELETE'),
    ).toHaveLength(2);
    await expect(
      env.TWITCH_SUBSCRIPTIONS_INDEX.get(
        createGuildTwitchSubscriptionKey(GUILD_ID, CHANNEL_ID, BROADCASTER_ID),
      ),
    ).resolves.toBeNull();
    await expect(
      env.TWITCH_SUBSCRIPTIONS_INDEX.get(
        createChannelTwitchSubscriptionKey(CHANNEL_ID, BROADCASTER_ID),
      ),
    ).resolves.toBeNull();
  });
});

describe('Twitch EventSub webhook', () => {
  it('verifies and answers a callback challenge', async () => {
    const body = JSON.stringify({
      challenge: 'challenge-value',
      subscription: {
        id: 'subscription-id',
        type: 'stream.online',
        condition: { broadcaster_user_id: WEBHOOK_BROADCASTER_ID },
      },
    });
    const request = await signedRequest('challenge-id', body, {
      type: 'webhook_callback_verification',
    });

    const response = await handleTwitchEventSub(
      request,
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('challenge-value');
  });

  it('rejects stale and incorrectly signed messages', async () => {
    const body = eventBody();
    const stale = await signedRequest('stale-id', body, {
      timestamp: '2020-01-01T00:00:00Z',
    });
    expect(
      (await handleTwitchEventSub(stale, env, createExecutionContext())).status,
    ).toBe(403);

    const invalid = await signedRequest('invalid-id', body);
    invalid.headers.set(
      'twitch-eventsub-message-signature',
      `sha256=${'0'.repeat(64)}`,
    );
    expect(
      (await handleTwitchEventSub(invalid, env, createExecutionContext()))
        .status,
    ).toBe(403);
  });

  it('rejects a signed payload with an invalid shape', async () => {
    const request = await signedRequest(
      'invalid-payload-id',
      JSON.stringify({ subscription: null }),
    );

    const response = await handleTwitchEventSub(
      request,
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('Invalid EventSub payload');
  });

  it('reconciles desired subscriptions after a normal notification', async () => {
    const createdTypes: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith('https://id.twitch.tv/oauth2/token')) {
        return Response.json({ access_token: 'token', expires_in: 3600 });
      }
      if (request.method === 'POST') {
        const body = await request.json<{
          type: string;
          version: string;
          condition: Record<string, string>;
          transport: { method: string; callback: string };
        }>();
        const remote = {
          id: `subscription-${body.type}`,
          status: 'webhook_callback_verification_pending',
          type: body.type,
          version: body.version,
          condition: body.condition,
          created_at: '2026-08-09T00:00:00Z',
          transport: body.transport,
          cost: 1,
        };
        createdTypes.push(body.type);
        return Response.json({ data: [remote] });
      }
      if (request.method === 'GET') {
        return Response.json({ data: [] });
      }
      throw new Error(
        `Unexpected Twitch request: ${request.method} ${request.url}`,
      );
    });

    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      RECONCILE_BROADCASTER_ID,
    );
    await subscription.addSubscriber(
      {
        id: RECONCILE_BROADCASTER_ID,
        login: 'sliroth',
        displayName: 'Sliroth',
        profileImageUrl: 'https://example.com/profile.png',
        offlineImageUrl: 'https://example.com/offline.png',
      },
      { guildId: GUILD_ID, channelId: CHANNEL_ID },
    );
    await runInDurableObject(subscription, async (_instance, state) => {
      await drizzle(state.storage)
        .delete(eventSubSubscriptions)
        .where(eq(eventSubSubscriptions.type, 'stream.online'));
    });
    createdTypes.length = 0;

    const body = JSON.stringify({
      subscription: {
        id: 'subscription-stream.offline',
        type: 'stream.offline',
        condition: { broadcaster_user_id: RECONCILE_BROADCASTER_ID },
      },
      event: {
        id: 'stream-id',
        broadcaster_user_id: RECONCILE_BROADCASTER_ID,
        broadcaster_user_login: 'sliroth',
        broadcaster_user_name: 'Sliroth',
      },
    });
    const response = await handleTwitchEventSub(
      await signedRequest(`notification-${crypto.randomUUID()}`, body, {
        broadcasterId: RECONCILE_BROADCASTER_ID,
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(createdTypes.sort()).toEqual(['stream.offline', 'stream.online']);
  });

  it('deduplicates Twitch message IDs in KV', async () => {
    const messageId = `notification-${crypto.randomUUID()}`;
    const body = eventBody();
    const firstContext = createExecutionContext();
    const first = await handleTwitchEventSub(
      await signedRequest(messageId, body, { type: 'revocation' }),
      env,
      firstContext,
    );
    await waitOnExecutionContext(firstContext);
    const second = await handleTwitchEventSub(
      await signedRequest(messageId, body, { type: 'revocation' }),
      env,
      createExecutionContext(),
    );

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    await expect(env.TWITCH_EVENT_IDS.get(messageId)).resolves.toBe('1');
  });
});

function eventBody(): string {
  return JSON.stringify({
    subscription: {
      id: 'subscription-id',
      type: 'stream.online',
      condition: { broadcaster_user_id: WEBHOOK_BROADCASTER_ID },
    },
    event: { broadcaster_user_id: WEBHOOK_BROADCASTER_ID },
  });
}

async function signedRequest(
  messageId: string,
  body: string,
  options: { broadcasterId?: string; type?: string; timestamp?: string } = {},
): Promise<Request> {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TWITCH_EVENTSUB_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(messageId + timestamp + body),
    ),
  );
  return new Request(
    `https://bot.example.com/twitch/eventsub/${options.broadcasterId ?? WEBHOOK_BROADCASTER_ID}`,
    {
      method: 'POST',
      headers: {
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-type': options.type ?? 'notification',
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-signature': `sha256=${toHex(signature)}`,
      },
      body,
    },
  );
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
