import { env, exports } from 'cloudflare:workers';
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribers } from '../../src/db/youtube-subscription/schema';
import { twitchSubscribers } from '../../src/db/twitch-subscription/schema';
import { handleDiscordInteraction } from '../../src/discord/interactions';

const GUILD_ID = '123456789012345678';
const CURRENT_CHANNEL_ID = '234567890123456789';
const OTHER_CHANNEL_ID = '345678901234567890';
const APPLICATION_ID = '456789012345678901';
const ROLE_ID = '567890123456789012';
const YOUTUBE_CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const CURRENT_YOUTUBE_CHANNEL_ID = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_YOUTUBE_CHANNEL_ID = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const TWITCH_ADD_BROADCASTER_ID = '678901234567890123';
const TWITCH_LIST_BROADCASTER_ID = '678901234567890124';
const TWITCH_REMOVE_BROADCASTER_ID = '678901234567890125';
const PRIVATE_KEY_SEED =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PRIVATE_KEY_PREFIX = '302e020100300506032b657004220420';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Discord interactions', () => {
  it('routes an authenticated Discord ping', async () => {
    const response = await exports.default.fetch(
      await createSignedRequest({ type: 1 }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it('rejects a signed interaction with an invalid payload shape', async () => {
    const response = await exports.default.fetch(
      await createSignedRequest({ type: 'ping' }),
    );

    expect(response.status).toBe(400);
  });

  it('rejects an invalid Discord permission bitfield at the boundary', async () => {
    const response = await exports.default.fetch(
      await createSignedRequest({
        ...createListInteraction(),
        app_permissions: 'invalid',
      }),
    );

    expect(response.status).toBe(400);
  });

  it('rejects an empty interaction token at the boundary', async () => {
    const response = await exports.default.fetch(
      await createSignedRequest({ ...createListInteraction(), token: '' }),
    );

    expect(response.status).toBe(400);
  });

  it('rejects an invalid signature', async () => {
    const response = await exports.default.fetch(
      'https://example.com/discord/interactions',
      {
        method: 'POST',
        headers: {
          'x-signature-ed25519': '00'.repeat(64),
          'x-signature-timestamp': '1754654400',
        },
        body: JSON.stringify({ type: 1 }),
      },
    );

    expect(response.status).toBe(401);
  });

  it('requires Manage Server permission', async () => {
    const response = await exports.default.fetch(
      await createSignedRequest(createListInteraction({ permissions: '0' })),
    );

    expect(await interactionContent(response)).toBe(
      'You need the Manage Server permission to use this command.',
    );
  });

  it('lists cached subscriptions ephemerally with the current channel first', async () => {
    await Promise.all([
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
        `guild:${GUILD_ID}:channel:${OTHER_CHANNEL_ID}:youtube:${OTHER_YOUTUBE_CHANNEL_ID}`,
        '1',
        { metadata: { title: 'Other channel' } },
      ),
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
        `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:youtube:${CURRENT_YOUTUBE_CHANNEL_ID}`,
        '1',
        { metadata: { title: 'Current channel' } },
      ),
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await exports.default.fetch(
      await createSignedRequest(createListInteraction()),
    );
    const body = await interactionBody(response);

    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.allowed_mentions).toEqual({ parse: [] });
    expect(body.data.content).toContain(
      `⭐ [Current channel](https://www.youtube.com/channel/${CURRENT_YOUTUBE_CHANNEL_ID}) → <#${CURRENT_CHANNEL_ID}> **— current channel**`,
    );
    expect(body.data.content.indexOf('Current channel')).toBeLessThan(
      body.data.content.indexOf('Other channel'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores a YouTube subscription without metadata', async () => {
    await env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
      `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:youtube:UC_MISSING`,
      '1',
    );
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await handleDiscordInteraction(
      await createSignedRequest(createListInteraction()),
      env,
      createExecutionContext(),
    );
    expect(await interactionContent(response)).not.toContain('UC_MISSING');
    expect(warnSpy).toHaveBeenCalledWith({
      event: 'youtube_subscription_index_key_invalid',
      key: `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:youtube:UC_MISSING`,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('adds a YouTube channel and completes the deferred response', async () => {
    const requests: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (request.url.startsWith('https://www.youtube.com/feeds/videos.xml')) {
        return Promise.resolve(
          new Response('<feed><title>Google for Developers</title></feed>'),
        );
      }
      if (request.url === 'https://pubsubhubbub.appspot.com/subscribe') {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      if (
        request.method === 'PATCH' &&
        request.url.includes('/messages/@original')
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(
        new Error(`Unexpected fetch: ${request.method} ${request.url}`),
      );
    });
    const ctx = createExecutionContext();

    const response = await handleDiscordInteraction(
      await createSignedRequest(createAddInteraction(YOUTUBE_CHANNEL_ID)),
      env,
      ctx,
    );
    expect(await deferredInteractionBody(response)).toEqual({
      type: 5,
      flags: 64,
    });

    await waitOnExecutionContext(ctx);

    expect(
      await env.YOUTUBE_SUBSCRIPTIONS_INDEX.get(
        `channel:${CURRENT_CHANNEL_ID}:youtube:${YOUTUBE_CHANNEL_ID}`,
      ),
    ).toBe('1');
    await expect(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.getWithMetadata(
        `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:youtube:${YOUTUBE_CHANNEL_ID}`,
      ),
    ).resolves.toMatchObject({
      value: '1',
      metadata: { title: 'Google for Developers' },
    });
    await expect(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.get(
        `youtube:${YOUTUBE_CHANNEL_ID}:title`,
      ),
    ).resolves.toBeNull();

    const editRequest = requests.find(
      (request) =>
        request.method === 'PATCH' &&
        request.url.includes('/messages/@original'),
    );
    expect(editRequest).toBeDefined();
    expect(await editRequest?.json()).toEqual({
      content: `Uploads from **Google for Developers** will be posted in <#${CURRENT_CHANNEL_ID}>.`,
      allowed_mentions: { parse: [] },
    });
  });

  it('rejects duplicate YouTube add options', async () => {
    const response = await exports.default.fetch(
      await createSignedRequest(
        createAddInteraction(YOUTUBE_CHANNEL_ID, {
          options: [{ type: 3, name: 'youtube', value: YOUTUBE_CHANNEL_ID }],
        }),
      ),
    );

    expect(await interactionContent(response)).toBe(
      'This interaction is not supported.',
    );
  });

  it('removes every YouTube notification from the current channel', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://pubsubhubbub.appspot.com/subscribe') {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      if (
        request.method === 'PATCH' &&
        request.url.includes('/messages/@original')
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(
        new Error(`Unexpected fetch: ${request.method} ${request.url}`),
      );
    });
    await env.YOUTUBE_SUBSCRIPTIONS.getByName(YOUTUBE_CHANNEL_ID).addSubscriber(
      {
        guildId: GUILD_ID,
        channelId: CURRENT_CHANNEL_ID,
        channelTitle: 'Google for Developers',
      },
    );
    const ctx = createExecutionContext();

    const response = await handleDiscordInteraction(
      await createSignedRequest(createRemoveInteraction()),
      env,
      ctx,
    );
    expect(await deferredInteractionBody(response)).toEqual({
      type: 5,
      flags: 64,
    });
    await waitOnExecutionContext(ctx);

    expect(
      await env.YOUTUBE_SUBSCRIPTIONS_INDEX.get(
        `channel:${CURRENT_CHANNEL_ID}:youtube:${YOUTUBE_CHANNEL_ID}`,
      ),
    ).toBeNull();
  });

  it('stores a custom message and mentionable role', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith('https://www.youtube.com/feeds/videos.xml')) {
        return Promise.resolve(
          new Response('<feed><title>A channel</title></feed>'),
        );
      }
      if (request.url === 'https://pubsubhubbub.appspot.com/subscribe') {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      if (request.method === 'PATCH') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${request.url}`));
    });
    const ctx = createExecutionContext();

    await handleDiscordInteraction(
      await createSignedRequest(
        createAddInteraction(YOUTUBE_CHANNEL_ID, {
          options: [
            { type: 8, name: 'role', value: ROLE_ID },
            { type: 3, name: 'message', value: 'A custom message' },
          ],
          resolvedRoles: { [ROLE_ID]: { id: ROLE_ID, mentionable: true } },
        }),
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const rows = await runInDurableObject(
      env.YOUTUBE_SUBSCRIPTIONS.getByName(YOUTUBE_CHANNEL_ID),
      async (_instance, state) =>
        drizzle(state.storage).select().from(subscribers),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        channelId: CURRENT_CHANNEL_ID,
        guildId: GUILD_ID,
        message: 'A custom message',
        ping: ROLE_ID,
      }),
    ]);
  });

  it('rejects add when the bot cannot send messages in the channel', async () => {
    const response = await exports.default.fetch(
      await createSignedRequest(
        createAddInteraction(YOUTUBE_CHANNEL_ID, { appPermissions: '1024' }),
      ),
    );

    expect(await interactionContent(response)).toBe(
      'I need View Channel and Send Messages permissions in this channel.',
    );
  });

  it('requires Mention Everyone permission for an @everyone ping', async () => {
    const response = await exports.default.fetch(
      await createSignedRequest(
        createAddInteraction(YOUTUBE_CHANNEL_ID, {
          options: [{ type: 3, name: 'ping', value: 'everyone' }],
        }),
      ),
    );

    expect(await interactionContent(response)).toBe(
      'I need Mention Everyone permission to use @everyone or @here.',
    );
  });

  it('adds a Twitch channel with its live, offline, and ping settings', async () => {
    const requests = mockTwitchApi(TWITCH_ADD_BROADCASTER_ID, 'sliroth');
    const ctx = createExecutionContext();

    const response = await handleDiscordInteraction(
      await createSignedRequest(
        createTwitchAddInteraction('sliroth', {
          options: [
            { type: 8, name: 'role', value: ROLE_ID },
            { type: 3, name: 'message', value: 'Sliroth is live now!' },
            { type: 3, name: 'offline', value: 'Sliroth was live.' },
          ],
          resolvedRoles: { [ROLE_ID]: { id: ROLE_ID, mentionable: true } },
        }),
      ),
      env,
      ctx,
    );
    expect(await deferredInteractionBody(response)).toEqual({
      type: 5,
      flags: 64,
    });
    await waitOnExecutionContext(ctx);

    const rows = await runInDurableObject(
      env.TWITCH_SUBSCRIPTIONS.getByName(TWITCH_ADD_BROADCASTER_ID),
      async (_instance, state) =>
        drizzle(state.storage).select().from(twitchSubscribers),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        channelId: CURRENT_CHANNEL_ID,
        guildId: GUILD_ID,
        message: 'Sliroth is live now!',
        offline: 'Sliroth was live.',
        ping: ROLE_ID,
      }),
    ]);
    await expect(
      env.TWITCH_SUBSCRIPTIONS_INDEX.getWithMetadata(
        `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:twitch:${TWITCH_ADD_BROADCASTER_ID}`,
      ),
    ).resolves.toMatchObject({
      value: '1',
      metadata: { login: 'sliroth', displayName: 'Sliroth' },
    });
    const editRequest = requests.find(
      (request) =>
        request.method === 'PATCH' &&
        request.url.includes('/messages/@original'),
    );
    expect(await editRequest?.json()).toEqual({
      content: `Streams from **Sliroth** will be posted in <#${CURRENT_CHANNEL_ID}> and mention <@&${ROLE_ID}>.`,
      allowed_mentions: { parse: [] },
    });
  });

  it('reports a Twitch channel that cannot be resolved', async () => {
    const requests = mockTwitchApi(TWITCH_ADD_BROADCASTER_ID, 'missing', false);
    const ctx = createExecutionContext();

    const response = await handleDiscordInteraction(
      await createSignedRequest(createTwitchAddInteraction('missing')),
      env,
      ctx,
    );
    expect(await deferredInteractionBody(response)).toEqual({
      type: 5,
      flags: 64,
    });
    await waitOnExecutionContext(ctx);

    const editRequest = requests.find(
      (request) =>
        request.method === 'PATCH' &&
        request.url.includes('/messages/@original'),
    );
    expect(await editRequest?.json()).toEqual({
      content:
        'That Twitch channel could not be resolved. Try its login, numeric broadcaster ID, or full channel URL.',
      allowed_mentions: { parse: [] },
    });
  });

  it('lists Twitch subscriptions with the current channel first', async () => {
    const requests = mockTwitchApi(TWITCH_LIST_BROADCASTER_ID, 'sliroth');
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      TWITCH_LIST_BROADCASTER_ID,
    );
    const broadcaster = twitchBroadcaster(
      TWITCH_LIST_BROADCASTER_ID,
      'sliroth',
    );
    await subscription.addSubscriber(broadcaster, {
      guildId: GUILD_ID,
      channelId: OTHER_CHANNEL_ID,
    });
    await subscription.addSubscriber(broadcaster, {
      guildId: GUILD_ID,
      channelId: CURRENT_CHANNEL_ID,
    });
    const requestCount = requests.length;

    const response = await handleDiscordInteraction(
      await createSignedRequest(createTwitchListInteraction()),
      env,
      createExecutionContext(),
    );
    const content = await interactionContent(response);

    expect(content).toContain(
      `⭐ [Sliroth](https://www.twitch.tv/sliroth) → <#${CURRENT_CHANNEL_ID}> **— current channel**`,
    );
    expect(content.indexOf(CURRENT_CHANNEL_ID)).toBeLessThan(
      content.indexOf(OTHER_CHANNEL_ID),
    );
    expect(requests).toHaveLength(requestCount);
  });

  it('ignores a Twitch subscription without metadata', async () => {
    const key = `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:twitch:${TWITCH_LIST_BROADCASTER_ID}`;
    await env.TWITCH_SUBSCRIPTIONS_INDEX.put(key, '1');
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await handleDiscordInteraction(
      await createSignedRequest(createTwitchListInteraction()),
      env,
      createExecutionContext(),
    );

    expect(await interactionContent(response)).not.toContain(
      TWITCH_LIST_BROADCASTER_ID,
    );
    expect(warnSpy).toHaveBeenCalledWith({
      event: 'twitch_subscription_index_key_invalid',
      key,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('removes every Twitch notification from the current channel', async () => {
    mockTwitchApi(TWITCH_REMOVE_BROADCASTER_ID, 'sliroth');
    await env.TWITCH_SUBSCRIPTIONS.getByName(
      TWITCH_REMOVE_BROADCASTER_ID,
    ).addSubscriber(
      twitchBroadcaster(TWITCH_REMOVE_BROADCASTER_ID, 'sliroth'),
      { guildId: GUILD_ID, channelId: CURRENT_CHANNEL_ID },
    );
    const ctx = createExecutionContext();

    const response = await handleDiscordInteraction(
      await createSignedRequest(createTwitchRemoveInteraction()),
      env,
      ctx,
    );
    expect(await deferredInteractionBody(response)).toEqual({
      type: 5,
      flags: 64,
    });
    await waitOnExecutionContext(ctx);

    await expect(
      env.TWITCH_SUBSCRIPTIONS_INDEX.get(
        `channel:${CURRENT_CHANNEL_ID}:twitch:${TWITCH_REMOVE_BROADCASTER_ID}`,
      ),
    ).resolves.toBeNull();
  });

  it('rejects Twitch add when the bot cannot embed links', async () => {
    const response = await exports.default.fetch(
      await createSignedRequest(
        createTwitchAddInteraction('sliroth', {
          appPermissions: '3072',
        }),
      ),
    );

    expect(await interactionContent(response)).toBe(
      'I need Embed Links permission in this channel.',
    );
  });
});

function createListInteraction({ permissions = '32' } = {}) {
  return {
    type: 2,
    application_id: APPLICATION_ID,
    token: 'interaction-token',
    guild_id: GUILD_ID,
    channel_id: CURRENT_CHANNEL_ID,
    channel: { id: CURRENT_CHANNEL_ID, type: 0 },
    app_permissions: '3072',
    member: { permissions },
    data: {
      type: 1,
      name: 'youtube',
      options: [{ type: 1, name: 'list' }],
    },
  };
}

function createAddInteraction(
  youtube: string,
  {
    appPermissions = '3072',
    options = [],
    resolvedRoles,
  }: {
    appPermissions?: string;
    options?: unknown[];
    resolvedRoles?: Record<string, unknown>;
  } = {},
) {
  return {
    type: 2,
    application_id: APPLICATION_ID,
    token: 'interaction-token',
    guild_id: GUILD_ID,
    channel_id: CURRENT_CHANNEL_ID,
    channel: { id: CURRENT_CHANNEL_ID, type: 0 },
    app_permissions: appPermissions,
    member: { permissions: '32' },
    data: {
      type: 1,
      name: 'youtube',
      resolved:
        resolvedRoles === undefined ? undefined : { roles: resolvedRoles },
      options: [
        {
          type: 1,
          name: 'add',
          options: [{ type: 3, name: 'youtube', value: youtube }, ...options],
        },
      ],
    },
  };
}

function createRemoveInteraction() {
  return {
    type: 2,
    application_id: APPLICATION_ID,
    token: 'interaction-token',
    guild_id: GUILD_ID,
    channel_id: CURRENT_CHANNEL_ID,
    channel: { id: CURRENT_CHANNEL_ID, type: 0 },
    app_permissions: '3072',
    member: { permissions: '32' },
    data: {
      type: 1,
      name: 'youtube',
      options: [{ type: 1, name: 'remove' }],
    },
  };
}

function createTwitchListInteraction() {
  return {
    ...createListInteraction(),
    data: {
      type: 1,
      name: 'twitch',
      options: [{ type: 1, name: 'list' }],
    },
  };
}

function createTwitchAddInteraction(
  twitch: string,
  {
    appPermissions = '19456',
    options = [],
    resolvedRoles,
  }: {
    appPermissions?: string;
    options?: unknown[];
    resolvedRoles?: Record<string, unknown>;
  } = {},
) {
  return {
    ...createListInteraction(),
    app_permissions: appPermissions,
    data: {
      type: 1,
      name: 'twitch',
      resolved:
        resolvedRoles === undefined ? undefined : { roles: resolvedRoles },
      options: [
        {
          type: 1,
          name: 'add',
          options: [{ type: 3, name: 'twitch', value: twitch }, ...options],
        },
      ],
    },
  };
}

function createTwitchRemoveInteraction() {
  return {
    ...createListInteraction(),
    data: {
      type: 1,
      name: 'twitch',
      options: [{ type: 1, name: 'remove' }],
    },
  };
}

function mockTwitchApi(
  broadcasterId: string,
  login: string,
  found = true,
): Request[] {
  const requests: Request[] = [];
  const subscriptions = new Map<string, Record<string, unknown>>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());

    if (request.url.startsWith('https://id.twitch.tv/oauth2/token')) {
      return Response.json({ access_token: 'token', expires_in: 3600 });
    }
    if (request.url.startsWith('https://api.twitch.tv/helix/users')) {
      return Response.json({
        data: found
          ? [
              {
                id: broadcasterId,
                login,
                display_name: 'Sliroth',
                profile_image_url: 'https://example.com/profile.png',
                offline_image_url: 'https://example.com/offline.png',
              },
            ]
          : [],
      });
    }
    if (
      request.url.startsWith(
        'https://api.twitch.tv/helix/eventsub/subscriptions',
      )
    ) {
      if (request.method === 'POST') {
        const body = await request.json<{
          type: string;
          version: string;
          condition: Record<string, string>;
          transport: { method: string; callback: string };
        }>();
        const subscription = {
          id: `${broadcasterId}-${body.type}`,
          status: 'webhook_callback_verification_pending',
          type: body.type,
          version: body.version,
          condition: body.condition,
          created_at: '2026-08-09T00:00:00Z',
          transport: body.transport,
          cost: 1,
        };
        subscriptions.set(subscription.id, subscription);
        return Response.json({ data: [subscription] });
      }
      if (request.method === 'GET') {
        const id = new URL(request.url).searchParams.get('id');
        const subscription = id === null ? undefined : subscriptions.get(id);
        return Response.json({ data: subscription ? [subscription] : [] });
      }
      if (request.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }
    if (
      request.method === 'PATCH' &&
      request.url.includes('/messages/@original')
    ) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
  });
  return requests;
}

function twitchBroadcaster(id: string, login: string) {
  return {
    id,
    login,
    displayName: 'Sliroth',
    profileImageUrl: 'https://example.com/profile.png',
    offlineImageUrl: 'https://example.com/offline.png',
  };
}

async function createSignedRequest(body: unknown): Promise<Request> {
  const timestamp = '1754654400';
  const encodedBody = new TextEncoder().encode(JSON.stringify(body));
  const encodedTimestamp = new TextEncoder().encode(timestamp);
  const signedContent = new Uint8Array(
    encodedTimestamp.byteLength + encodedBody.byteLength,
  );
  signedContent.set(encodedTimestamp);
  signedContent.set(encodedBody, encodedTimestamp.byteLength);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    hexToBytes(`${PRIVATE_KEY_PREFIX}${PRIVATE_KEY_SEED}`),
    'Ed25519',
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('Ed25519', key, signedContent);

  return new Request('https://example.com/discord/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': bytesToHex(new Uint8Array(signature)),
      'x-signature-timestamp': timestamp,
    },
    body: encodedBody,
  });
}

async function interactionContent(response: Response): Promise<string> {
  return (await interactionBody(response)).data.content;
}

async function interactionBody(response: Response): Promise<{
  type: number;
  data: {
    content: string;
    flags: number;
    allowed_mentions: { parse: string[] };
  };
}> {
  return response.json<{
    type: number;
    data: {
      content: string;
      flags: number;
      allowed_mentions: { parse: string[] };
    };
  }>();
}

async function deferredInteractionBody(
  response: Response,
): Promise<{ type: number; flags: number }> {
  const { type, data } = await response.json<{
    type: number;
    data: { flags: number };
  }>();
  return { type, flags: data.flags };
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
