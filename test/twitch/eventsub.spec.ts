import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  getEventSubMessageType,
  parseEventSubMessage,
  verifyEventSubRequest,
} from '../../src/twitch/eventsub';

const SECRET = '0123456789abcdef';

async function createSignature(
  messageId: string,
  timestamp: string,
  body: string,
  secret = SECRET,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${messageId}${timestamp}${body}`),
  );

  return `sha256=${Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

describe('parseEventSubMessage', () => {
  it('parses channel updates', () => {
    expect(
      parseEventSubMessage('notification', {
        subscription: {
          id: 'subscription-1',
          type: 'channel.update',
          version: '2',
          condition: { broadcaster_user_id: '123' },
        },
        event: {
          broadcaster_user_id: '123',
          broadcaster_user_login: 'sliroth',
          broadcaster_user_name: 'Sliroth',
          title: 'Jelly Armed Man',
          language: 'en',
          category_id: 'game-1',
          category_name: 'Gothic 1 Remake',
          content_classification_labels: ['MatureGame'],
        },
      }),
    ).toMatchObject({
      messageType: 'notification',
      eventType: 'channel.update',
      event: {
        broadcasterId: '123',
        title: 'Jelly Armed Man',
        gameId: 'game-1',
      },
    });
  });

  it('returns normalized subscription metadata and notification data', () => {
    expect(
      parseEventSubMessage('notification', {
        subscription: {
          id: 'subscription-1',
          type: 'stream.online',
          version: '1',
          condition: { broadcaster_user_id: '123' },
        },
        event: {
          id: 'stream-1',
          broadcaster_user_id: '123',
          broadcaster_user_login: 'sliroth',
          broadcaster_user_name: 'Sliroth',
          type: 'live',
          started_at: '2026-08-13T18:30:00Z',
        },
      }),
    ).toEqual({
      messageType: 'notification',
      eventType: 'stream.online',
      subscription: {
        id: 'subscription-1',
        type: 'stream.online',
        version: '1',
        broadcasterId: '123',
      },
      event: {
        streamId: 'stream-1',
        broadcasterId: '123',
        broadcasterLogin: 'sliroth',
        broadcasterName: 'Sliroth',
        startedAt: '2026-08-13T18:30:00Z',
      },
    });
  });

  it('parses stream offline notifications', () => {
    expect(
      parseEventSubMessage('notification', {
        subscription: {
          id: 'subscription-1',
          type: 'stream.offline',
          version: '1',
          condition: { broadcaster_user_id: '123' },
        },
        event: {
          id: 'stream-1',
          broadcaster_user_id: '123',
          broadcaster_user_login: 'sliroth',
          broadcaster_user_name: 'Sliroth',
        },
      }),
    ).toMatchObject({
      messageType: 'notification',
      eventType: 'stream.offline',
      event: { streamId: 'stream-1', broadcasterId: '123' },
    });
  });

  it('rejects unsupported notification types', () => {
    expect(() =>
      parseEventSubMessage('notification', {
        subscription: {
          id: 'subscription-1',
          type: 'channel.follow',
          version: '2',
          condition: { broadcaster_user_id: '123' },
        },
        event: {},
      }),
    ).toThrow('Unsupported Twitch EventSub type: channel.follow');
  });

  it('rejects malformed notification events', () => {
    expect(() =>
      parseEventSubMessage('notification', {
        subscription: {
          id: 'subscription-1',
          type: 'stream.online',
          version: '1',
          condition: { broadcaster_user_id: '123' },
        },
        event: { started_at: 'not-a-date' },
      }),
    ).toThrow(z.ZodError);
  });

  it('parses verification challenges with subscription metadata', () => {
    expect(
      parseEventSubMessage('webhook_callback_verification', {
        challenge: 'challenge-token',
        subscription: {
          id: 'subscription-1',
          type: 'stream.online',
          version: '1',
          condition: { broadcaster_user_id: '123' },
        },
      }),
    ).toEqual({
      messageType: 'webhook_callback_verification',
      challenge: 'challenge-token',
      subscription: {
        id: 'subscription-1',
        type: 'stream.online',
        version: '1',
        broadcasterId: '123',
      },
    });
  });

  it('parses revocations with their status', () => {
    expect(
      parseEventSubMessage('revocation', {
        subscription: {
          id: 'subscription-1',
          type: 'stream.online',
          version: '1',
          status: 'authorization_revoked',
          condition: { broadcaster_user_id: '123' },
        },
      }),
    ).toEqual({
      messageType: 'revocation',
      subscription: {
        id: 'subscription-1',
        type: 'stream.online',
        version: '1',
        broadcasterId: '123',
        status: 'authorization_revoked',
      },
    });
  });

  it('rejects messages without a broadcaster condition', () => {
    expect(() =>
      parseEventSubMessage('revocation', {
        subscription: {
          id: 'subscription-1',
          type: 'stream.online',
          version: '1',
          status: 'authorization_revoked',
        },
      }),
    ).toThrow(z.ZodError);
  });
});

describe('verifyEventSubRequest', () => {
  it('accepts a request with a valid Twitch signature', async () => {
    const body = JSON.stringify({
      subscription: {
        id: 'subscription-1',
      },
      event: {
        id: 'stream-1',
      },
    });

    const messageId = 'message-123';
    const timestamp = '2026-08-13T18:30:00Z';
    const signature = await createSignature(messageId, timestamp, body);

    const request = new Request('https://example.com/twitch/eventsub', {
      method: 'POST',
      headers: {
        'Twitch-Eventsub-Message-Id': messageId,
        'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Signature': signature,
      },
      body,
    });

    await expect(verifyEventSubRequest(request, body, SECRET)).resolves.toBe(
      true,
    );
  });

  it('rejects a request when the body does not match the signature', async () => {
    const signedBody = JSON.stringify({
      event: {
        id: 'stream-1',
      },
    });

    const receivedBody = JSON.stringify({
      event: {
        id: 'stream-2',
      },
    });

    const messageId = 'message-123';
    const timestamp = '2026-08-13T18:30:00Z';
    const signature = await createSignature(messageId, timestamp, signedBody);

    const request = new Request('https://example.com/twitch/eventsub', {
      method: 'POST',
      headers: {
        'Twitch-Eventsub-Message-Id': messageId,
        'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Signature': signature,
      },
      body: receivedBody,
    });

    await expect(
      verifyEventSubRequest(request, receivedBody, SECRET),
    ).resolves.toBe(false);
  });

  it('rejects a request with the wrong secret', async () => {
    const body = '{}';
    const messageId = 'message-123';
    const timestamp = '2026-08-13T18:30:00Z';

    const signature = await createSignature(
      messageId,
      timestamp,
      body,
      'different-secret',
    );

    const request = new Request('https://example.com/twitch/eventsub', {
      method: 'POST',
      headers: {
        'Twitch-Eventsub-Message-Id': messageId,
        'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Signature': signature,
      },
      body,
    });

    await expect(verifyEventSubRequest(request, body, SECRET)).resolves.toBe(
      false,
    );
  });

  it('rejects a malformed signature', async () => {
    const body = '{}';

    const request = new Request('https://example.com/twitch/eventsub', {
      method: 'POST',
      headers: {
        'Twitch-Eventsub-Message-Id': 'message-123',
        'Twitch-Eventsub-Message-Timestamp': '2026-08-13T18:30:00Z',
        'Twitch-Eventsub-Message-Signature': 'not-a-signature',
      },
      body,
    });

    await expect(verifyEventSubRequest(request, body, SECRET)).resolves.toBe(
      false,
    );
  });

  it.each([
    'Twitch-Eventsub-Message-Id',
    'Twitch-Eventsub-Message-Timestamp',
    'Twitch-Eventsub-Message-Signature',
  ])('rejects a request missing %s', async (missingHeader) => {
    const body = '{}';

    const headers = new Headers({
      'Twitch-Eventsub-Message-Id': 'message-123',
      'Twitch-Eventsub-Message-Timestamp': '2026-08-13T18:30:00Z',
      'Twitch-Eventsub-Message-Signature':
        'sha256=0000000000000000000000000000000000000000000000000000000000000000',
    });

    headers.delete(missingHeader);

    const request = new Request('https://example.com/twitch/eventsub', {
      method: 'POST',
      headers,
      body,
    });

    await expect(verifyEventSubRequest(request, body, SECRET)).resolves.toBe(
      false,
    );
  });

  it('verifies the exact raw body rather than reparsed JSON', async () => {
    const signedBody = '{ "event": { "id": "stream-1" } }';
    const normalizedBody = '{"event":{"id":"stream-1"}}';

    const messageId = 'message-123';
    const timestamp = '2026-08-13T18:30:00Z';

    const signature = await createSignature(messageId, timestamp, signedBody);

    const request = new Request('https://example.com/twitch/eventsub', {
      method: 'POST',
      headers: {
        'Twitch-Eventsub-Message-Id': messageId,
        'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Signature': signature,
      },
      body: signedBody,
    });

    await expect(
      verifyEventSubRequest(request, signedBody, SECRET),
    ).resolves.toBe(true);

    await expect(
      verifyEventSubRequest(request, normalizedBody, SECRET),
    ).resolves.toBe(false);
  });
});

describe('getEventSubMessageType', () => {
  it.each([
    'notification',
    'webhook_callback_verification',
    'revocation',
  ] as const)('returns %s for supported message types', (type) => {
    const request = new Request('https://example.com', {
      headers: {
        'Twitch-Eventsub-Message-Type': type,
      },
    });

    expect(getEventSubMessageType(request)).toBe(type);
  });

  it('returns undefined for unsupported message types', () => {
    const request = new Request('https://example.com', {
      headers: {
        'Twitch-Eventsub-Message-Type': 'unknown',
      },
    });

    expect(getEventSubMessageType(request)).toBeUndefined();
  });

  it('returns undefined when the message type header is missing', () => {
    const request = new Request('https://example.com');

    expect(getEventSubMessageType(request)).toBeUndefined();
  });
});
