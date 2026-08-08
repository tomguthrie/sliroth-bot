import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleDiscordInteraction } from '../../src/discord/interaction';

const GUILD_ID = '123456789012345678';
const CURRENT_CHANNEL_ID = '234567890123456789';
const OTHER_CHANNEL_ID = '345678901234567890';
const APPLICATION_ID = '456789012345678901';
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
    );

    expect(await interactionContent(response)).toContain(
      '[UC\\_FALLBACK](https://www.youtube.com/channel/UC_FALLBACK)',
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
    member: { permissions },
    data: {
      type: 1,
      name: 'youtube',
      options: [{ type: 1, name: 'list' }],
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
  data: { content: string; flags: number; allowed_mentions: unknown };
}> {
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value.type !== 'number') {
    throw new Error('Discord response is invalid');
  }
  if (!isRecord(value.data) || typeof value.data.content !== 'string') {
    throw new Error('Discord response data is invalid');
  }
  if (typeof value.data.flags !== 'number') {
    throw new Error('Discord response flags are invalid');
  }
  return {
    type: value.type,
    data: {
      content: value.data.content,
      flags: value.data.flags,
      allowed_mentions: value.data.allowed_mentions,
    },
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
