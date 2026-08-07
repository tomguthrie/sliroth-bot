import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendDiscordMessage } from '../../src/discord/client';

const BOT_TOKEN = 'test-discord-bot-token';
const CHANNEL_ID = '123456789012345678';
const ROLE_ID = '234567890123456789';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendDiscordMessage', () => {
  it('sends the message and discards the successful response body', async () => {
    const discordResponse = new Response(
      JSON.stringify({ id: '345678901234567890' }),
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

    await expect(
      sendDiscordMessage(createMessageOptions()),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(discordResponse.bodyUsed).toBe(true);
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
