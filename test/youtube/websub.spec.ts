import { describe, expect, it } from 'vitest';

import {
  createYouTubeWebSubRequest,
  verifyYouTubeWebSubSignature,
  YOUTUBE_WEBSUB_HUB_URL,
} from '../../src/youtube/websub';

describe('createYouTubeWebSubRequest', () => {
  it('creates a form-encoded YouTube subscription request', async () => {
    const request = createYouTubeWebSubRequest({
      mode: 'subscribe',
      channelId: 'UC_TEST_CHANNEL_ID',
      publicBaseUrl: 'https://bot.example.com',
      callbackToken: 'test-callback-token',
      secret: 'test-websub-secret',
    });

    expect(request.url).toBe(YOUTUBE_WEBSUB_HUB_URL);
    expect(request.method).toBe('POST');
    expect(request.headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );

    const body = await request.formData();

    expect(Object.fromEntries(body)).toEqual({
      'hub.mode': 'subscribe',
      'hub.topic':
        'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC_TEST_CHANNEL_ID',
      'hub.callback':
        'https://bot.example.com/youtube/websub/test-callback-token',
      'hub.secret': 'test-websub-secret',
    });
  });
});

describe('verifyYouTubeWebSubSignature', () => {
  it('accepts a valid notification signature', async () => {
    const secret = 'test-websub-secret';
    const body = Uint8Array.from(
      new TextEncoder().encode('<feed>test</feed>'),
    ).buffer;
    const signature = await createSignature(body, secret);

    await expect(
      verifyYouTubeWebSubSignature(body, signature, secret),
    ).resolves.toBe(true);
  });

  it('rejects missing, malformed, and incorrect signatures', async () => {
    const body = Uint8Array.from(
      new TextEncoder().encode('<feed>test</feed>'),
    ).buffer;

    await expect(
      verifyYouTubeWebSubSignature(body, null, 'test-websub-secret'),
    ).resolves.toBe(false);

    await expect(
      verifyYouTubeWebSubSignature(
        body,
        'sha1=not-a-valid-signature',
        'test-websub-secret',
      ),
    ).resolves.toBe(false);

    await expect(
      verifyYouTubeWebSubSignature(
        body,
        `sha1=${'00'.repeat(20)}`,
        'test-websub-secret',
      ),
    ).resolves.toBe(false);
  });
});

async function createSignature(
  body: ArrayBuffer,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-1',
    },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, body);

  const signatureHex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return `sha1=${signatureHex}`;
}
