import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDiscordMessageRequest,
  DISCORD_API_BASE_URL,
  sendDiscordMessage,
} from '../../src/discord/message';

const BOT_TOKEN = 'test-discord-bot-token';
const CHANNEL_ID = '123456789012345678';
const ROLE_ID = '234567890123456789';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDiscordMessageRequest', () => {
  it('creates an authenticated role-mention message', async () => {
    const request = createDiscordMessageRequest({
      botToken: BOT_TOKEN,
      channelId: CHANNEL_ID,
      applicationUrl: 'https://bot.example.com/youtube/websub/private-token',
      message: {
        content: `<@&${ROLE_ID}> A new video is available`,
        nonce: 'dQw4w9WgXcQ',
        allowedMentions: {
          roleIds: [ROLE_ID],
        },
      },
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
      content: `<@&${ROLE_ID}> A new video is available`,
      nonce: 'dQw4w9WgXcQ',
      enforce_nonce: true,
      allowed_mentions: {
        parse: [],
        roles: [ROLE_ID],
      },
    });
  });

  it('disables mentions by default', async () => {
    const request = createDiscordMessageRequest({
      botToken: BOT_TOKEN,
      channelId: CHANNEL_ID,
      applicationUrl: 'https://bot.example.com',
      message: {
        content: '@everyone This text does not notify anyone',
      },
    });

    const body: unknown = await request.json();

    expect(body).toEqual({
      content: '@everyone This text does not notify anyone',
      allowed_mentions: {
        parse: [],
      },
    });
  });

  it('allows explicit user and everyone mentions', async () => {
    const userId = '345678901234567890';
    const request = createDiscordMessageRequest({
      botToken: BOT_TOKEN,
      channelId: CHANNEL_ID,
      applicationUrl: 'https://bot.example.com',
      message: {
        content: `@everyone <@${userId}> Please take a look`,
        allowedMentions: {
          userIds: [userId],
          everyone: true,
        },
      },
    });

    const body: unknown = await request.json();

    expect(body).toEqual({
      content: `@everyone <@${userId}> Please take a look`,
      allowed_mentions: {
        parse: ['everyone'],
        users: [userId],
      },
    });
  });

  it('rejects an invalid channel ID', () => {
    expect(() =>
      createDiscordMessageRequest({
        botToken: BOT_TOKEN,
        channelId: 'not-a-snowflake',
        applicationUrl: 'https://bot.example.com',
        message: {
          content: 'A message',
        },
      }),
    ).toThrow('Discord channel ID must be a Discord snowflake');
  });

  it('rejects an invalid role ID', () => {
    expect(() =>
      createDiscordMessageRequest({
        botToken: BOT_TOKEN,
        channelId: CHANNEL_ID,
        applicationUrl: 'https://bot.example.com',
        message: {
          content: 'A message',
          allowedMentions: {
            roleIds: ['not-a-snowflake'],
          },
        },
      }),
    ).toThrow('Discord role ID must be a Discord snowflake');
  });
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
