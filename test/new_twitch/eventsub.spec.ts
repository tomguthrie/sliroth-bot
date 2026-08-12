import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  getEventSubMessageType,
  parseEventSubChallenge,
  parseEventSubNotification,
  parseEventSubRevocation,
  verifyEventSubRequest,
} from '../../src/new_twitch/eventsub';

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

describe('parseEventSubNotification', () => {
  it('parses channel.update notifications', () => {
    expect(
      parseEventSubNotification({
        subscription: {
          id: 'subscription-1',
          type: 'channel.update',
          version: '2',
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
    ).toEqual({
      type: 'channel.update',
      broadcasterId: '123',
      broadcasterLogin: 'sliroth',
      broadcasterName: 'Sliroth',
      title: 'Jelly Armed Man',
      language: 'en',
      gameId: 'game-1',
      gameName: 'Gothic 1 Remake',
      contentClassificationLabels: ['MatureGame'],
    });
  });

  it('parses stream.online notifications', () => {
    expect(
      parseEventSubNotification({
        subscription: {
          id: 'subscription-2',
          type: 'stream.online',
          version: '1',
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
      type: 'stream.online',
      streamId: 'stream-1',
      broadcasterId: '123',
      broadcasterLogin: 'sliroth',
      broadcasterName: 'Sliroth',
      startedAt: new Date('2026-08-13T18:30:00Z'),
    });
  });

  it('parses stream.offline notifications', () => {
    expect(
      parseEventSubNotification({
        subscription: {
          id: 'subscription-3',
          type: 'stream.offline',
          version: '1',
        },
        event: {
          id: 'stream-1',
          broadcaster_user_id: '123',
          broadcaster_user_login: 'sliroth',
          broadcaster_user_name: 'Sliroth',
        },
      }),
    ).toEqual({
      type: 'stream.offline',
      streamId: 'stream-1',
      broadcasterId: '123',
      broadcasterLogin: 'sliroth',
      broadcasterName: 'Sliroth',
    });
  });

  it('rejects unsupported notification types', () => {
    expect(() =>
      parseEventSubNotification({
        subscription: {
          id: 'subscription-4',
          type: 'channel.follow',
          version: '2',
        },
        event: {},
      }),
    ).toThrow('Unsupported Twitch EventSub type: channel.follow');
  });

  it('rejects malformed notification envelopes', () => {
    expect(() =>
      parseEventSubNotification({
        subscription: {
          type: 'stream.online',
        },
        event: {},
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects malformed channel.update events', () => {
    expect(() =>
      parseEventSubNotification({
        subscription: {
          id: 'subscription-1',
          type: 'channel.update',
          version: '2',
        },
        event: {
          broadcaster_user_id: '123',
          broadcaster_user_login: 'sliroth',
          broadcaster_user_name: 'Sliroth',
          title: 'Jelly Armed Man',
          language: 'en',
          category_id: 'game-1',
          category_name: 'Gothic 1 Remake',
          content_classification_labels: 'MatureGame',
        },
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects malformed stream.online events', () => {
    expect(() =>
      parseEventSubNotification({
        subscription: {
          id: 'subscription-2',
          type: 'stream.online',
          version: '1',
        },
        event: {
          id: 'stream-1',
          broadcaster_user_id: '123',
          broadcaster_user_login: 'sliroth',
          broadcaster_user_name: 'Sliroth',
          type: 'live',
          started_at: 'not-a-date',
        },
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects malformed stream.offline events', () => {
    expect(() =>
      parseEventSubNotification({
        subscription: {
          id: 'subscription-3',
          type: 'stream.offline',
          version: '1',
        },
        event: {
          id: 'stream-1',
          broadcaster_user_id: 123,
          broadcaster_user_login: 'sliroth',
          broadcaster_user_name: 'Sliroth',
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

describe('parseEventSubChallenge', () => {
  it('returns the challenge string', () => {
    expect(
      parseEventSubChallenge({
        challenge: 'challenge-token',
      }),
    ).toBe('challenge-token');
  });

  it('rejects a non-string challenge', () => {
    expect(() =>
      parseEventSubChallenge({
        challenge: 123,
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects a missing challenge', () => {
    expect(() => parseEventSubChallenge({})).toThrow(z.ZodError);
  });
});

describe('parseEventSubRevocation', () => {
  it('parses a revoked EventSub subscription', () => {
    expect(
      parseEventSubRevocation({
        subscription: {
          id: 'subscription-1',
          type: 'stream.online',
          version: '1',
          status: 'authorization_revoked',
        },
      }),
    ).toEqual({
      subscription: {
        id: 'subscription-1',
        type: 'stream.online',
        version: '1',
        status: 'authorization_revoked',
      },
    });
  });

  it('preserves other Twitch revocation statuses', () => {
    expect(
      parseEventSubRevocation({
        subscription: {
          id: 'subscription-1',
          type: 'stream.online',
          version: '1',
          status: 'notification_failures_exceeded',
        },
      }),
    ).toEqual({
      subscription: {
        id: 'subscription-1',
        type: 'stream.online',
        version: '1',
        status: 'notification_failures_exceeded',
      },
    });
  });

  it('rejects a revocation with a missing status', () => {
    expect(() =>
      parseEventSubRevocation({
        subscription: {
          id: 'subscription-1',
          type: 'stream.online',
          version: '1',
        },
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects malformed revocation envelopes', () => {
    expect(() =>
      parseEventSubRevocation({
        subscription: 'subscription-1',
      }),
    ).toThrow(z.ZodError);
  });
});
