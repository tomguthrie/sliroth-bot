import { describe, expect, it } from 'vitest';

import {
  createDiscordVideoMessageRequest,
  DISCORD_API_BASE_URL,
} from '../../src/discord/message';

const BOT_TOKEN = 'test-discord-bot-token';
const CHANNEL_ID = '123456789012345678';
const ROLE_ID = '234567890123456789';

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
