import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import {
  DiscordApiError,
  editDiscordMessage,
  sendDiscordMessage,
} from '../../src/discord/client';

const BOT_TOKEN = 'test-discord-bot-token';
const CHANNEL_ID = '123456789012345678';
const ROLE_ID = '234567890123456789';
const MESSAGE_ID = '345678901234567890';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendDiscordMessage', () => {
  it('sends the message and returns its receipt', async () => {
    const discordResponse = new Response(
      JSON.stringify({ id: MESSAGE_ID, channel_id: CHANNEL_ID }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(discordResponse);

    await expect(sendDiscordMessage(createMessageOptions())).resolves.toEqual({
      messageId: MESSAGE_ID,
      channelId: CHANNEL_ID,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(discordResponse.bodyUsed).toBe(true);
  });

  it('edits an exact message and returns its receipt', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ id: MESSAGE_ID, channel_id: CHANNEL_ID }),
      );

    await expect(
      editDiscordMessage({
        ...createMessageOptions(),
        messageId: MESSAGE_ID,
      }),
    ).resolves.toEqual({ messageId: MESSAGE_ID, channelId: CHANNEL_ID });

    const request = fetchSpy.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    if (!(request instanceof Request)) throw new Error('Expected a Request');
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe(
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
    );
  });

  it('rejects an invalid successful response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ id: 123, channel_id: CHANNEL_ID }),
    );

    await expect(
      sendDiscordMessage(createMessageOptions()),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('includes Discord error details when delivery fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"Missing Access","code":50001}', {
        status: 403,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(sendDiscordMessage(createMessageOptions())).rejects.toThrow(
      'Discord rejected the message with HTTP 403: {"message":"Missing Access","code":50001}',
    );
  });

  it('handles a failed response without a body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    await expect(sendDiscordMessage(createMessageOptions())).rejects.toThrow(
      'Discord rejected the message with HTTP 503: no response body',
    );
  });

  it('exposes Discord rate-limit retry timing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Rate limited', {
        status: 429,
        headers: { 'retry-after': '1.25' },
      }),
    );

    const error = await sendDiscordMessage(createMessageOptions()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DiscordApiError);
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 1.25 });
  });
});

function createMessageOptions() {
  return {
    botToken: BOT_TOKEN,
    channelId: CHANNEL_ID,
    applicationUrl: 'https://bot.example.com',
    message: {
      content: `<@&${ROLE_ID}> A new video is available`,
      nonce: 'dQw4w9WgXcQ',
      allowedMentions: {
        roleIds: [ROLE_ID],
      },
    },
  };
}
