import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import {
  DiscordApiError,
  editDiscordMessage,
  sendDiscordMessage,
  type DiscordMessage,
} from '../../src/discord';

const BOT_TOKEN = 'test-discord-bot-token';
const CHANNEL_ID = '123456789012345678';
const ROLE_ID = '234567890123456789';
const MESSAGE_ID = '345678901234567890';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Discord message client', () => {
  it('creates an authenticated, idempotent role-mention message', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ id: MESSAGE_ID, channel_id: CHANNEL_ID }),
      );

    await expect(
      sendDiscordMessage(
        createOptions({
          content: `<@&${ROLE_ID}> A new video is available`,
          nonce: 'dQw4w9WgXcQ',
          allowedMentions: { roleIds: [ROLE_ID] },
        }),
      ),
    ).resolves.toEqual({ messageId: MESSAGE_ID, channelId: CHANNEL_ID });

    const request = requireRequest(fetcher.mock.calls[0]?.[0]);
    expect(request.method).toBe('POST');
    expect(request.url).toBe(
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
    );
    expect(request.headers.get('authorization')).toBe(`Bot ${BOT_TOKEN}`);
    expect(request.headers.get('user-agent')).toBe(
      'DiscordBot (https://bot.example.com, 0.0.0)',
    );
    await expect(request.json()).resolves.toEqual({
      content: `<@&${ROLE_ID}> A new video is available`,
      nonce: 'dQw4w9WgXcQ',
      enforce_nonce: true,
      allowed_mentions: { parse: [], roles: [ROLE_ID] },
    });
  });

  it('suppresses mentions unless explicitly enabled', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ id: MESSAGE_ID, channel_id: CHANNEL_ID }),
      );

    await sendDiscordMessage(
      createOptions({ content: '@everyone This is plain text' }),
    );
    await expect(
      requireRequest(fetcher.mock.calls[0]?.[0]).json(),
    ).resolves.toEqual({
      content: '@everyone This is plain text',
      allowed_mentions: { parse: [] },
    });
  });

  it('serializes the embed and link button features used by Twitch', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ id: MESSAGE_ID, channel_id: CHANNEL_ID }),
      );
    const message: DiscordMessage = {
      content: '@here Sliroth is live!',
      allowedMentions: { everyone: true },
      embeds: [
        {
          author: {
            name: 'Sliroth',
            iconUrl: 'https://example.com/profile.png',
          },
          title: 'A stream',
          url: 'https://twitch.tv/sliroth',
          color: 0x9146ff,
          fields: [{ name: 'Viewers', value: '3', inline: true }],
          thumbnail: { url: 'https://example.com/game.jpg' },
          image: { url: 'https://example.com/preview.jpg' },
          footer: { text: 'Started streaming' },
          timestamp: '2026-06-05T17:28:00.000Z',
        },
      ],
      linkButtons: [
        { label: 'Watch Stream', url: 'https://twitch.tv/sliroth' },
      ],
    };

    await sendDiscordMessage(createOptions(message));

    await expect(
      requireRequest(fetcher.mock.calls[0]?.[0]).json(),
    ).resolves.toEqual({
      content: '@here Sliroth is live!',
      allowed_mentions: { parse: ['everyone'] },
      embeds: [
        {
          author: {
            name: 'Sliroth',
            icon_url: 'https://example.com/profile.png',
          },
          title: 'A stream',
          url: 'https://twitch.tv/sliroth',
          color: 0x9146ff,
          fields: [{ name: 'Viewers', value: '3', inline: true }],
          thumbnail: { url: 'https://example.com/game.jpg' },
          image: { url: 'https://example.com/preview.jpg' },
          footer: { text: 'Started streaming' },
          timestamp: '2026-06-05T17:28:00.000Z',
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: 'Watch Stream',
              url: 'https://twitch.tv/sliroth',
            },
          ],
        },
      ],
    });
  });

  it('edits the requested message', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ id: MESSAGE_ID, channel_id: CHANNEL_ID }),
      );

    await editDiscordMessage({
      ...createOptions({ content: 'Stream ended' }),
      messageId: MESSAGE_ID,
    });

    const request = requireRequest(fetcher.mock.calls[0]?.[0]);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe(
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
    );
  });

  it('rejects malformed successful responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ id: 123, channel_id: CHANNEL_ID }),
    );

    await expect(
      sendDiscordMessage(createOptions({ content: 'Message' })),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('exposes Discord error details and retry timing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Rate limited', {
        status: 429,
        headers: { 'retry-after': '1.25' },
      }),
    );

    const error = await sendDiscordMessage(
      createOptions({ content: 'Message' }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiscordApiError);
    expect(error).toMatchObject({
      message: 'Discord rejected the message with HTTP 429: Rate limited',
      status: 429,
      retryAfterSeconds: 1.25,
    });
  });
});

function createOptions(message: DiscordMessage) {
  return {
    botToken: BOT_TOKEN,
    channelId: CHANNEL_ID,
    applicationUrl: 'https://bot.example.com/private/path',
    message,
  };
}

function requireRequest(value: RequestInfo | URL | undefined): Request {
  if (!(value instanceof Request)) throw new Error('Expected a Request');
  return value;
}
