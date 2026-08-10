import { describe, expect, it } from 'vitest';

import { YouTubeChannelId, YouTubeWebSubSecret } from '../../src/youtube/data';
import {
  createYouTubeWebSubRequest,
  verifyYouTubeWebSubSignature,
  WebSubLeaseSeconds,
  YOUTUBE_WEBSUB_HUB_URL,
} from '../../src/youtube/websub';
import { WebSubChallenge } from '../../src/youtube/websub-handler';

const CHANNEL_ID = YouTubeChannelId.parse('UC_x5XG1OV2P6uZZ5FSM9Ttw');
const SECRET = YouTubeWebSubSecret.parse('test-websub-secret');

describe('WebSub values', () => {
  it('validates challenges and lease durations', () => {
    expect(WebSubChallenge.parse('challenge-123')).toBe('challenge-123');
    expect(WebSubChallenge.safeParse('contains a space').success).toBe(false);
    expect(WebSubLeaseSeconds.parse(1_000)).toBe(1_000);
    expect(WebSubLeaseSeconds.safeParse(0).success).toBe(false);
  });
});

describe('createYouTubeWebSubRequest', () => {
  it('creates a form-encoded YouTube subscription request', async () => {
    const request = createYouTubeWebSubRequest({
      mode: 'subscribe',
      channelId: CHANNEL_ID,
      publicBaseUrl: 'https://bot.example.com',
      secret: SECRET,
    });

    expect(request.url).toBe(YOUTUBE_WEBSUB_HUB_URL);
    expect(request.method).toBe('POST');
    expect(request.headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );

    const body = await request.formData();

    expect(Object.fromEntries(body)).toEqual({
      'hub.mode': 'subscribe',
      'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      'hub.callback': `https://bot.example.com/youtube/websub/${CHANNEL_ID}`,
      'hub.secret': SECRET,
    });
  });
});

describe('verifyYouTubeWebSubSignature', () => {
  it('accepts a valid notification signature', async () => {
    const secret = SECRET;
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
      verifyYouTubeWebSubSignature(body, null, SECRET),
    ).resolves.toBe(false);

    await expect(
      verifyYouTubeWebSubSignature(body, 'sha1=not-a-valid-signature', SECRET),
    ).resolves.toBe(false);

    await expect(
      verifyYouTubeWebSubSignature(body, `sha1=${'00'.repeat(20)}`, SECRET),
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
