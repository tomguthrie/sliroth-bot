import {
  createExecutionContext,
  env,
  runInDurableObject,
} from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  eventSubSubscriptions,
  processedEventSubMessages,
} from '../../src/db/twitch-subscription/schema';
import type { TwitchSubscription } from '../../src/twitch-subscription/durable-object';
import { handleTwitchEventSub } from '../../src/twitch-subscription/eventsub-handler';
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
  it('accepts a broadcaster without an offline banner', async () => {
    const requests: {
      method: string;
      url: string;
      eventType?: string;
      eventVersion?: string;
    }[] = [];
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
          eventVersion: body.version,
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
        offlineImageUrl: '',
      },
      { guildId: GUILD_ID, channelId: CHANNEL_ID },
    );

    expect(
      requests
        .filter(
          ({ method, url }) => method === 'POST' && url.includes('/helix/'),
        )
        .map(({ eventType, eventVersion }) => [eventType, eventVersion])
        .sort(([left], [right]) => left?.localeCompare(right ?? '') ?? 0),
    ).toEqual([
      ['channel.update', '2'],
      ['stream.offline', '1'],
      ['stream.online', '1'],
    ]);
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
    ).toHaveLength(3);
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
        version: '1',
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

  it('queues an authenticated channel update', async () => {
    const broadcasterId = '123456789012345681';
    const send = vi
      .spyOn(env.SUBSCRIPTION_EVENTS, 'send')
      .mockResolvedValue(queueSendResponse());
    const body = channelUpdateBody(broadcasterId);
    const messageId = `channel-update-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();

    const response = await handleTwitchEventSub(
      await signedRequest(messageId, body, { broadcasterId, timestamp }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(send).toHaveBeenCalledWith({
      kind: 'twitch-eventsub',
      messageId,
      timestamp,
      message: {
        messageType: 'notification',
        eventType: 'channel.update',
        subscription: {
          id: 'subscription-channel.update',
          type: 'channel.update',
          version: '2',
          broadcasterId,
        },
        event: channelUpdateEvent(broadcasterId),
      },
    });
  });

  it('queues parsed notifications using their JSON-safe message shape', async () => {
    const broadcasterId = '123456789012345683';
    const send = vi
      .spyOn(env.SUBSCRIPTION_EVENTS, 'send')
      .mockResolvedValue(queueSendResponse());
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      subscription: {
        id: 'subscription-stream.online',
        type: 'stream.online',
        version: '1',
        condition: { broadcaster_user_id: broadcasterId },
      },
      event: {
        id: 'stream-1',
        broadcaster_user_id: broadcasterId,
        broadcaster_user_login: 'sliroth',
        broadcaster_user_name: 'Sliroth',
        type: 'live',
        started_at: '2026-08-13T18:30:00Z',
      },
    });

    const response = await handleTwitchEventSub(
      await signedRequest('stream-online-id', body, {
        broadcasterId,
        timestamp,
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(send).toHaveBeenCalledWith({
      kind: 'twitch-eventsub',
      messageId: 'stream-online-id',
      timestamp,
      message: {
        messageType: 'notification',
        eventType: 'stream.online',
        subscription: {
          id: 'subscription-stream.online',
          type: 'stream.online',
          version: '1',
          broadcasterId,
        },
        event: {
          streamId: 'stream-1',
          broadcasterId,
          broadcasterLogin: 'sliroth',
          broadcasterName: 'Sliroth',
          startedAt: '2026-08-13T18:30:00Z',
        },
      },
    });
  });

  it('queues authenticated revocations', async () => {
    const broadcasterId = '123456789012345684';
    const send = vi
      .spyOn(env.SUBSCRIPTION_EVENTS, 'send')
      .mockResolvedValue(queueSendResponse());
    const body = JSON.stringify({
      subscription: {
        id: 'subscription-revoked',
        type: 'stream.online',
        version: '1',
        status: 'authorization_revoked',
        condition: { broadcaster_user_id: broadcasterId },
      },
    });

    const response = await handleTwitchEventSub(
      await signedRequest('revocation-id', body, {
        broadcasterId,
        type: 'revocation',
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'twitch-eventsub',
        messageId: 'revocation-id',
        message: {
          messageType: 'revocation',
          subscription: {
            id: 'subscription-revoked',
            type: 'stream.online',
            version: '1',
            status: 'authorization_revoked',
            broadcasterId,
          },
        },
      }),
    );
  });

  it('rejects a broadcaster that does not match the callback route', async () => {
    const body = channelUpdateBody(WEBHOOK_BROADCASTER_ID);
    const response = await handleTwitchEventSub(
      await signedRequest('mismatch-id', body, {
        broadcasterId: '123456789012345699',
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe(
      'EventSub broadcaster mismatch',
    );
  });

  it('rejects an invalid channel update event', async () => {
    const body = JSON.stringify({
      subscription: {
        id: 'subscription-id',
        type: 'channel.update',
        version: '2',
        condition: { broadcaster_user_id: WEBHOOK_BROADCASTER_ID },
      },
      event: { broadcaster_user_id: WEBHOOK_BROADCASTER_ID },
    });

    const response = await handleTwitchEventSub(
      await signedRequest(`channel-update-${crypto.randomUUID()}`, body),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('Invalid EventSub payload');
  });

  it('repairs only locally missing subscriptions after a normal notification', async () => {
    const createdTypes: string[] = [];
    let eventSubReads = 0;
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
        if (new URL(request.url).pathname.endsWith('/eventsub/subscriptions')) {
          eventSubReads += 1;
        }
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
    eventSubReads = 0;

    await subscription.processEventSubMessage({
      kind: 'twitch-eventsub',
      messageId: `notification-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      message: {
        messageType: 'notification',
        eventType: 'channel.update',
        subscription: {
          id: 'subscription-channel.update',
          type: 'channel.update',
          version: '2',
          broadcasterId: RECONCILE_BROADCASTER_ID,
        },
        event: channelUpdateEvent(RECONCILE_BROADCASTER_ID),
      },
    });

    expect(createdTypes).toEqual(['stream.online']);
    expect(eventSubReads).toBe(0);
  });

  it('deduplicates processed Twitch message IDs in SQLite', async () => {
    const broadcasterId = '123456789012345682';
    const messageId = `notification-${crypto.randomUUID()}`;
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId);
    const delivery = {
      kind: 'twitch-eventsub',
      messageId,
      timestamp: new Date().toISOString(),
      message: {
        messageType: 'notification',
        eventType: 'channel.update',
        subscription: {
          id: 'subscription-channel',
          type: 'channel.update',
          version: '2',
          broadcasterId,
        },
        event: channelUpdateEvent(broadcasterId),
      },
    } as const;

    const processed = await runInDurableObject(
      subscription,
      async (instance, state) => {
        const channelUpdate = vi
          .spyOn(instance, 'channelUpdate')
          .mockResolvedValue(undefined);
        await instance.processEventSubMessage(delivery);
        await instance.processEventSubMessage(delivery);
        expect(channelUpdate).toHaveBeenCalledOnce();
        return drizzle(state.storage).select().from(processedEventSubMessages);
      },
    );
    expect(processed).toHaveLength(1);
    expect(processed[0]?.messageId).toBe(messageId);
    expect(processed[0]?.processedAt).toBeInstanceOf(Date);
  });
});

function eventBody(): string {
  return JSON.stringify({
    subscription: {
      id: 'subscription-id',
      type: 'stream.online',
      version: '1',
      condition: { broadcaster_user_id: WEBHOOK_BROADCASTER_ID },
    },
    event: { broadcaster_user_id: WEBHOOK_BROADCASTER_ID },
  });
}

function channelUpdateBody(broadcasterId: string): string {
  return JSON.stringify({
    subscription: {
      id: 'subscription-channel.update',
      type: 'channel.update',
      version: '2',
      condition: { broadcaster_user_id: broadcasterId },
    },
    event: channelUpdateWireEvent(broadcasterId),
  });
}

function channelUpdateWireEvent(broadcasterId: string) {
  return {
    broadcaster_user_id: broadcasterId,
    broadcaster_user_login: 'sliroth',
    broadcaster_user_name: 'Sliroth',
    title: 'Updated title',
    language: 'en',
    category_id: '84',
    category_name: 'Science & Technology',
    content_classification_labels: [],
  };
}

function channelUpdateEvent(broadcasterId: string) {
  return {
    broadcasterId,
    broadcasterLogin: 'sliroth',
    broadcasterName: 'Sliroth',
    title: 'Updated title',
    language: 'en',
    gameId: '84',
    gameName: 'Science & Technology',
    contentClassificationLabels: [],
  };
}

function queueSendResponse(): QueueSendResponse {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
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
