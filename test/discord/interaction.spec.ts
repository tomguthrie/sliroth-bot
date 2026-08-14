import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import {
  createDiscordInteractionHandler,
  type DiscordCommandHandler,
} from '../../src/discord';

const PRIVATE_KEY_SEED =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PRIVATE_KEY_PREFIX = '302e020100300506032b657004220420';

describe('Discord interaction boundary', () => {
  it('responds to an authenticated ping', async () => {
    const handleDiscordInteraction = createHandler();
    const response = await handleDiscordInteraction(
      await createSignedRequest({ type: 1 }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it('rejects a request without a valid signature', async () => {
    const handleDiscordInteraction = createHandler();
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
    const handleDiscordInteraction = createHandler();
    const response = await handleDiscordInteraction(
      await createSignedRequestFromText('{"type":'),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
  });

  it('rejects an invalid authenticated envelope', async () => {
    const handleDiscordInteraction = createHandler();
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

  it('dispatches a registered application command', async () => {
    const commandHandler = vi.fn<DiscordCommandHandler['handle']>(() =>
      Promise.resolve(new Response('handled', { status: 202 })),
    );
    const handleDiscordInteraction = createHandler(commandHandler);
    const ctx = createExecutionContext();
    const response = await handleDiscordInteraction(
      await createSignedRequest(createListInteraction()),
      env,
      ctx,
    );

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe('handled');
    expect(commandHandler).toHaveBeenCalledOnce();
    expect(commandHandler.mock.calls[0]?.[0].data?.name).toBe('youtube');
    expect(commandHandler.mock.calls[0]?.[1]).toBe(env);
    expect(commandHandler.mock.calls[0]?.[2]).toBe(ctx);
  });

  it('rejects duplicate command registrations', () => {
    const command: DiscordCommandHandler = {
      name: 'youtube',
      handle: () => Promise.resolve(new Response()),
    };

    expect(() => createDiscordInteractionHandler([command, command])).toThrow(
      'Duplicate Discord command: youtube',
    );
  });

  it('responds ephemerally to an unregistered application command', async () => {
    const handleDiscordInteraction = createHandler();
    const interaction = createListInteraction();
    interaction.data.name = 'unknown';

    const response = await handleDiscordInteraction(
      await createSignedRequest(interaction),
      env,
      createExecutionContext(),
    );

    await expect(response.json()).resolves.toMatchObject({
      type: 4,
      data: { content: 'This interaction is not supported.', flags: 64 },
    });
  });

  it('responds ephemerally to unsupported authenticated interactions', async () => {
    const handleDiscordInteraction = createHandler();
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

function createHandler(
  handle: DiscordCommandHandler['handle'] = () =>
    Promise.resolve(new Response()),
) {
  return createDiscordInteractionHandler([{ name: 'youtube', handle }]);
}

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
