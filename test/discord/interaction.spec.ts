import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { handleDiscordInteraction } from '../../src/discord';

const PRIVATE_KEY_SEED =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PRIVATE_KEY_PREFIX = '302e020100300506032b657004220420';

describe('Discord interaction boundary', () => {
  it('responds to an authenticated ping', async () => {
    const response = await handleDiscordInteraction(
      await createSignedRequest({ type: 1 }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it('rejects a request without a valid signature', async () => {
    const response = await handleDiscordInteraction(
      new Request('https://example.com/discord/interactions', {
        method: 'POST',
        headers: {
          'x-signature-ed25519': '00'.repeat(64),
          'x-signature-timestamp': '1754654400',
        },
        body: JSON.stringify({ type: 1 }),
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
  });

  it('rejects malformed authenticated JSON', async () => {
    const response = await handleDiscordInteraction(
      await createSignedRequestFromText('{"type":'),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
  });

  it('rejects an invalid authenticated envelope', async () => {
    const response = await handleDiscordInteraction(
      await createSignedRequest({
        ...createListInteraction(),
        app_permissions: 'invalid',
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
  });

  it('dispatches a valid YouTube list command', async () => {
    const response = await handleDiscordInteraction(
      await createSignedRequest(createListInteraction()),
      env,
      createExecutionContext(),
    );
    const body = await response.json<{
      type: number;
      data: { content: string; flags: number; allowed_mentions: unknown };
    }>();

    expect(body).toEqual({
      type: 4,
      data: {
        content: 'No YouTube notifications are configured for this server.',
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
  });

  it('responds ephemerally to unsupported authenticated interactions', async () => {
    const response = await handleDiscordInteraction(
      await createSignedRequest({ type: 3 }),
      env,
      createExecutionContext(),
    );

    await expect(response.json()).resolves.toMatchObject({
      type: 4,
      data: { content: 'This interaction is not supported.', flags: 64 },
    });
  });
});

function createListInteraction() {
  return {
    type: 2,
    application_id: '123456789012345678',
    token: 'interaction-token',
    guild_id: '234567890123456789',
    channel_id: '345678901234567890',
    channel: { type: 0 },
    app_permissions: '3072',
    member: { permissions: '32' },
    data: {
      name: 'youtube',
      options: [{ type: 1, name: 'list' }],
    },
  };
}

async function createSignedRequest(body: unknown): Promise<Request> {
  return createSignedRequestFromText(JSON.stringify(body));
}

async function createSignedRequestFromText(body: string): Promise<Request> {
  const timestamp = '1754654400';
  const encodedBody = new TextEncoder().encode(body);
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
