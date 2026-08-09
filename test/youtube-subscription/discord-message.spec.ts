import { describe, expect, it } from 'vitest';

import { DiscordSnowflake } from '../../src/discord/snowflake';
import { createYouTubeDiscordMessage } from '../../src/youtube-subscription/discord-message';

const NOTIFICATION = {
  videoId: 'dQw4w9WgXcQ',
  channelId: 'youtube-channel-id',
  title: 'A YouTube video',
  publishedAt: '2026-08-07T12:34:56.789Z',
};
const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '234567890123456789';
const ROLE_ID = DiscordSnowflake.parse('345678901234567890');
const CREATED_AT = new Date('2026-08-01T12:00:00.000Z');
const UPDATED_AT = new Date('2026-08-02T12:00:00.000Z');

const SUBSCRIBER = {
  guildId: GUILD_ID,
  channelId: CHANNEL_ID,
  message: null,
  ping: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

describe('YouTube Discord message', () => {
  it('builds the default message without allowing mentions', async () => {
    const delivery = await createYouTubeDiscordMessage(
      NOTIFICATION,
      SUBSCRIBER,
    );

    expect(delivery).toMatchObject({
      operation: 'create',
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      message: {
        content: 'A new video has been uploaded! https://youtu.be/dQw4w9WgXcQ',
        allowedMentions: undefined,
      },
    });
    expect(delivery.message.nonce).toHaveLength(25);
  });

  it.each([
    [
      'everyone',
      '@everyone A custom message https://youtu.be/dQw4w9WgXcQ',
      { everyone: true },
    ],
    [
      'here',
      '@here A custom message https://youtu.be/dQw4w9WgXcQ',
      { everyone: true },
    ],
    [
      ROLE_ID,
      `<@&${ROLE_ID}> A custom message https://youtu.be/dQw4w9WgXcQ`,
      { roleIds: [ROLE_ID] },
    ],
  ] as const)(
    'maps the %s ping to Discord content and allowed mentions',
    async (ping, content, allowedMentions) => {
      const delivery = await createYouTubeDiscordMessage(NOTIFICATION, {
        ...SUBSCRIBER,
        message: 'A custom message',
        ping,
      });

      expect(delivery.message).toMatchObject({ content, allowedMentions });
    },
  );

  it('creates a stable nonce scoped to the Discord channel', async () => {
    const subscriber = SUBSCRIBER;
    const first = await createYouTubeDiscordMessage(NOTIFICATION, subscriber);
    const second = await createYouTubeDiscordMessage(NOTIFICATION, subscriber);
    const otherChannel = await createYouTubeDiscordMessage(NOTIFICATION, {
      ...subscriber,
      channelId: '456789012345678901',
    });

    expect(first.message.nonce).toBe(second.message.nonce);
    expect(first.message.nonce).not.toBe(otherChannel.message.nonce);
  });
});
