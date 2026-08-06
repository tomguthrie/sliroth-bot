import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDiscordVideoMessageRequest,
  DISCORD_API_BASE_URL,
  sendDiscordVideoMessage,
} from '../../src/discord/message';

const BOT_TOKEN = 'test-discord-bot-token';
const CHANNEL_ID = '123456789012345678';
const ROLE_ID = '234567890123456789';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDiscordVideoMessageRequest', () => {
  it('creates an authenticated role-mention message', async () => {
    const request = createDiscordVideoMessageRequest({
      botToken: BOT_TOKEN,
      channelId: CHANNEL_ID,
      roleId: ROLE_ID,
      applicationUrl: 'https://bot.example.com/youtube/websub/private-token',
      videoId: 'dQw4w9WgXcQ',
    });

    expect(request.url).toBe(
      `${DISCORD_API_BASE_URL}channels/${CHANNEL_ID}/messages`,
    );
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe(`Bot ${BOT_TOKEN}`);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('user-agent')).toBe(
      'DiscordBot (https://bot.example.com, 0.0.0)',
    );

    const body: unknown = await request.json();

    expect(body).toEqual({
      content: `<@&${ROLE_ID}> Sliroth just uploaded a video, go check it out! https://youtu.be/dQw4w9WgXcQ`,
      allowed_mentions: {
        parse: [],
        roles: [ROLE_ID],
      },
    });
  });

  it('rejects an invalid channel ID', () => {
    expect(() =>
      createDiscordVideoMessageRequest({
        botToken: BOT_TOKEN,
        channelId: 'not-a-snowflake',
        roleId: ROLE_ID,
        applicationUrl: 'https://bot.example.com',
        videoId: 'dQw4w9WgXcQ',
      }),
    ).toThrow('Discord channel ID must be a Discord snowflake');
  });

  it('rejects an invalid role ID', () => {
    expect(() =>
      createDiscordVideoMessageRequest({
        botToken: BOT_TOKEN,
        channelId: CHANNEL_ID,
        roleId: 'not-a-snowflake',
        applicationUrl: 'https://bot.example.com',
        videoId: 'dQw4w9WgXcQ',
      }),
    ).toThrow('Discord role ID must be a Discord snowflake');
  });
});

describe('sendDiscordVideoMessage', () => {
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
      sendDiscordVideoMessage(createMessageOptions()),
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

    await expect(
      sendDiscordVideoMessage(createMessageOptions()),
    ).rejects.toThrow(
      'Discord rejected the video message with HTTP 403: {"message":"Missing Access","code":50001}',
    );
  });

  it('handles a failed response without a body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    await expect(
      sendDiscordVideoMessage(createMessageOptions()),
    ).rejects.toThrow(
      'Discord rejected the video message with HTTP 503: no response body',
    );
  });
});

function createMessageOptions() {
  return {
    botToken: BOT_TOKEN,
    channelId: CHANNEL_ID,
    roleId: ROLE_ID,
    applicationUrl: 'https://bot.example.com',
    videoId: 'dQw4w9WgXcQ',
  };
}
