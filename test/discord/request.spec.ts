import { describe, expect, it } from 'vitest';

import {
  createDiscordMessageRequest,
  DISCORD_API_BASE_URL,
} from '../../src/discord/request';

const BOT_TOKEN = 'test-discord-bot-token';
const CHANNEL_ID = '123456789012345678';
const ROLE_ID = '234567890123456789';

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
    const request = createRequest({
      content: '@everyone This text does not notify anyone',
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
    const request = createRequest({
      content: `@everyone <@${userId}> Please take a look`,
      allowedMentions: {
        userIds: [userId],
        everyone: true,
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

  it('creates a live message with every supported embed component', async () => {
    const request = createRequest({
      content: '@here Sliroth is live now! https://twitch.tv/sliroth',
      allowedMentions: {
        everyone: true,
      },
      embeds: [
        {
          author: {
            name: 'Sliroth',
            iconUrl: 'https://static.example.com/sliroth-avatar.png',
          },
          title: 'Summer Game Fest 2026 | !discord !youtube',
          url: 'https://twitch.tv/sliroth',
          color: 0x9146ff,
          fields: [
            {
              name: 'Game',
              value: 'Special Events',
              inline: true,
            },
            {
              name: 'Viewers',
              value: '3',
              inline: true,
            },
          ],
          thumbnail: {
            url: 'https://static.example.com/special-events.jpg',
          },
          image: {
            url: 'https://static.example.com/live-preview.jpg',
          },
          footer: {
            text: 'Started streaming',
          },
          timestamp: '2026-06-05T17:28:00.000Z',
        },
      ],
      linkButtons: [
        {
          label: 'Watch Stream',
          url: 'https://twitch.tv/sliroth',
        },
        {
          label: 'YouTube',
          url: 'https://youtube.com/@sliroth',
        },
      ],
    });

    const body: unknown = await request.json();

    expect(body).toEqual({
      content: '@here Sliroth is live now! https://twitch.tv/sliroth',
      allowed_mentions: {
        parse: ['everyone'],
      },
      embeds: [
        {
          author: {
            name: 'Sliroth',
            icon_url: 'https://static.example.com/sliroth-avatar.png',
          },
          title: 'Summer Game Fest 2026 | !discord !youtube',
          url: 'https://twitch.tv/sliroth',
          color: 0x9146ff,
          fields: [
            {
              name: 'Game',
              value: 'Special Events',
              inline: true,
            },
            {
              name: 'Viewers',
              value: '3',
              inline: true,
            },
          ],
          thumbnail: {
            url: 'https://static.example.com/special-events.jpg',
          },
          image: {
            url: 'https://static.example.com/live-preview.jpg',
          },
          footer: {
            text: 'Started streaming',
          },
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
            {
              type: 2,
              style: 5,
              label: 'YouTube',
              url: 'https://youtube.com/@sliroth',
            },
          ],
        },
      ],
    });
  });

  it('creates an offline message without a thumbnail', async () => {
    const request = createRequest({
      content: 'Sliroth was live — thanks for watching!',
      embeds: [
        {
          author: {
            name: 'Sliroth',
            iconUrl: 'https://static.example.com/sliroth-avatar.png',
          },
          title: 'Jelly Armed Man Tries To Get Stronger | !discord !youtube',
          url: 'https://twitch.tv/videos/1234567890',
          color: 0x9146ff,
          fields: [
            { name: 'Game', value: 'Gothic 1 Remake', inline: true },
            { name: 'Duration', value: '6h 23m 8s', inline: true },
          ],
          image: {
            url: 'https://static.example.com/vod-preview.jpg',
          },
          footer: {
            text: 'Last online',
          },
          timestamp: '2026-06-06T20:55:00+01:00',
        },
      ],
      linkButtons: [
        {
          label: 'Watch VOD',
          url: 'https://twitch.tv/videos/1234567890',
        },
      ],
    });

    const body: unknown = await request.json();

    expect(body).toEqual({
      content: 'Sliroth was live — thanks for watching!',
      allowed_mentions: {
        parse: [],
      },
      embeds: [
        {
          author: {
            name: 'Sliroth',
            icon_url: 'https://static.example.com/sliroth-avatar.png',
          },
          title: 'Jelly Armed Man Tries To Get Stronger | !discord !youtube',
          url: 'https://twitch.tv/videos/1234567890',
          color: 0x9146ff,
          fields: [
            { name: 'Game', value: 'Gothic 1 Remake', inline: true },
            { name: 'Duration', value: '6h 23m 8s', inline: true },
          ],
          image: {
            url: 'https://static.example.com/vod-preview.jpg',
          },
          footer: {
            text: 'Last online',
          },
          timestamp: '2026-06-06T20:55:00+01:00',
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: 'Watch VOD',
              url: 'https://twitch.tv/videos/1234567890',
            },
          ],
        },
      ],
    });
  });

  it('preserves the order of multiple embeds', async () => {
    const request = createRequest({
      content: 'Two embeds',
      embeds: [{ title: 'First' }, { title: 'Second' }],
    });

    const body: unknown = await request.json();

    expect(body).toEqual({
      content: 'Two embeds',
      allowed_mentions: {
        parse: [],
      },
      embeds: [{ title: 'First' }, { title: 'Second' }],
    });
  });

  it.each([
    { embeds: [], error: 'Discord message embeds' },
    { embeds: Array.from({ length: 11 }, () => ({})), error: 'embeds' },
  ])('rejects an invalid embed count', ({ embeds, error }) => {
    expect(() => createRequest({ content: 'A message', embeds })).toThrow(
      error,
    );
  });

  it.each([
    { linkButtons: [], error: 'Discord message link buttons' },
    {
      linkButtons: Array.from({ length: 6 }, (_, index) => ({
        label: `Button ${index + 1}`,
        url: `https://example.com/${index + 1}`,
      })),
      error: 'link buttons',
    },
  ])('rejects an invalid link button count', ({ linkButtons, error }) => {
    expect(() => createRequest({ content: 'A message', linkButtons })).toThrow(
      error,
    );
  });

  it.each([-1, 0x1000000, 1.5])(
    'rejects an invalid embed color: %s',
    (color) => {
      expect(() =>
        createRequest({ content: 'A message', embeds: [{ color }] }),
      ).toThrow(
        'Discord embed 1 color must be an integer between 0 and 16777215',
      );
    },
  );

  it('rejects an invalid embed timestamp', () => {
    expect(() =>
      createRequest({
        content: 'A message',
        embeds: [{ timestamp: 'not-a-timestamp' }],
      }),
    ).toThrow('Discord embed 1 timestamp must be a valid ISO 8601 timestamp');
  });

  it.each([
    {
      message: { embeds: [{ url: 'not-a-url' }] },
      error: 'Discord embed 1 URL must be an HTTP(S) URL',
    },
    {
      message: { embeds: [{ image: { url: 'ftp://example.com/image.jpg' } }] },
      error: 'Discord embed 1 image URL must be an HTTP(S) URL',
    },
    {
      message: {
        linkButtons: [{ label: 'Open', url: 'javascript:alert(1)' }],
      },
      error: 'Discord link button 1 URL must be an HTTP(S) URL',
    },
  ])('rejects invalid URLs', ({ message, error }) => {
    expect(() => createRequest({ content: 'A message', ...message })).toThrow(
      error,
    );
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
      createRequest({
        content: 'A message',
        allowedMentions: {
          roleIds: ['not-a-snowflake'],
        },
      }),
    ).toThrow('Discord role ID must be a Discord snowflake');
  });
});

function createRequest(
  message: Parameters<typeof createDiscordMessageRequest>[0]['message'],
) {
  return createDiscordMessageRequest({
    botToken: BOT_TOKEN,
    channelId: CHANNEL_ID,
    applicationUrl: 'https://bot.example.com',
    message,
  });
}
