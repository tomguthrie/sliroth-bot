import { env, exports } from 'cloudflare:workers';
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribers } from '../../src/db/youtube-subscription/schema';
import { handleDiscordInteraction } from '../../src/discord/interactions';

const GUILD_ID = '123456789012345678';
const CURRENT_CHANNEL_ID = '234567890123456789';
const OTHER_CHANNEL_ID = '345678901234567890';
const APPLICATION_ID = '456789012345678901';
const ROLE_ID = '567890123456789012';
const YOUTUBE_CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
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
        `guild:${GUILD_ID}:channel:${OTHER_CHANNEL_ID}:youtube:UC_OTHER`,
        '1',
      ),
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
        `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:youtube:UC_CURRENT`,
        '1',
      ),
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
        'youtube:UC_OTHER:title',
        'Other channel',
      ),
      env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
        'youtube:UC_CURRENT:title',
        'Current channel',
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
      `⭐ [Current channel](https://www.youtube.com/channel/UC_CURRENT) → <#${CURRENT_CHANNEL_ID}> **— current channel**`,
    );
    expect(body.data.content.indexOf('Current channel')).toBeLessThan(
      body.data.content.indexOf('Other channel'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches and caches a missing title before responding', async () => {
    await env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
      `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:youtube:UC_MISSING`,
      '1',
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith('https://www.youtube.com/feeds/videos.xml')) {
        return Promise.resolve(
          new Response(
            '<feed xmlns="http://www.w3.org/2005/Atom"><title>Fetched title</title></feed>',
          ),
        );
      }
      return Promise.reject(
        new Error(`Unexpected fetch: ${request.method} ${request.url}`),
      );
    });

    const response = await handleDiscordInteraction(
      await createSignedRequest(createListInteraction()),
      env,
      createExecutionContext(),
    );
    const body = await interactionBody(response);

    expect(body.type).toBe(4);
    expect(body.data.content).toContain('[Fetched title]');
    expect(
      await env.YOUTUBE_SUBSCRIPTIONS_INDEX.get('youtube:UC_MISSING:title'),
    ).toBe('Fetched title');
  });

  it('falls back to the YouTube channel ID when a title fetch fails', async () => {
    await env.YOUTUBE_SUBSCRIPTIONS_INDEX.put(
      `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:youtube:UC_FALLBACK`,
      '1',
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    const response = await handleDiscordInteraction(
      await createSignedRequest(createListInteraction()),
      env,
      createExecutionContext(),
    );

    expect(await interactionContent(response)).toContain(
      '[UC\\_FALLBACK](https://www.youtube.com/channel/UC_FALLBACK)',
    );
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
    expect(
      await env.YOUTUBE_SUBSCRIPTIONS_INDEX.get(
        `guild:${GUILD_ID}:channel:${CURRENT_CHANNEL_ID}:youtube:${YOUTUBE_CHANNEL_ID}`,
      ),
    ).toBe('1');
    expect(
      await env.YOUTUBE_SUBSCRIPTIONS_INDEX.get(
        `youtube:${YOUTUBE_CHANNEL_ID}:title`,
      ),
    ).toBe('Google for Developers');

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
