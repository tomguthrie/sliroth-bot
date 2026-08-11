import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  createDiscordMentionPayload,
  createDiscordMessage,
  createDiscordMessageNonce,
  describeDiscordMention,
  type DiscordMessage,
} from '../../src/discord/message';
import { DiscordSnowflake } from '../../src/discord/snowflake';

const ROLE_ID = DiscordSnowflake.parse('123456789012345678');

describe('createDiscordMessage', () => {
  it('builds a validated Discord message', () => {
    const message: DiscordMessage = createDiscordMessage({
      content: 'A message',
      allowedMentions: { roleIds: [ROLE_ID] },
    });

    expect(message).toEqual({
      content: 'A message',
      allowedMentions: { roleIds: [ROLE_ID] },
    });
  });

  it.each([
    { content: '' },
    { content: 'A message', nonce: '' },
    { content: 'A message', embeds: Array.from({ length: 11 }, () => ({})) },
    {
      content: 'A message',
      linkButtons: Array.from({ length: 6 }, (_, index) => ({
        label: `Button ${index + 1}`,
        url: `https://example.com/${index + 1}`,
      })),
    },
    { content: 'A message', embeds: [{ color: -1 }] },
    { content: 'A message', embeds: [{ color: 0x1000000 }] },
    { content: 'A message', embeds: [{ color: 1.5 }] },
    {
      content: 'A message',
      embeds: [{ timestamp: 'not-a-timestamp' }],
    },
    { content: 'A message', embeds: [{ url: 'not-a-url' }] },
    {
      content: 'A message',
      embeds: [{ image: { url: 'ftp://example.com/image.jpg' } }],
    },
    {
      content: 'A message',
      linkButtons: [{ label: 'Open', url: 'javascript:alert(1)' }],
    },
  ])('rejects an invalid message: %#', (message) => {
    expect(() => createDiscordMessage(message)).toThrow(z.ZodError);
  });
});

describe('Discord notification messages', () => {
  it('omits an absent mention', () => {
    expect(createDiscordMentionPayload(null)).toEqual({});
  });

  it.each(['everyone', 'here'] as const)('enables an @%s mention', (target) => {
    expect(createDiscordMentionPayload(target)).toEqual({
      content: `@${target}`,
      allowedMentions: { everyone: true },
    });
  });

  it('enables one role mention', () => {
    expect(createDiscordMentionPayload(ROLE_ID)).toEqual({
      content: `<@&${ROLE_ID}>`,
      allowedMentions: { roleIds: [ROLE_ID] },
    });
  });

  it.each([
    [undefined, ''],
    ['everyone' as const, ' and mention @everyone'],
    ['here' as const, ' and mention @here'],
    [ROLE_ID, ` and mention <@&${ROLE_ID}>`],
  ])('describes %s for configuration summaries', (target, expected) => {
    expect(describeDiscordMention(target)).toBe(expected);
  });

  it('creates a deterministic bounded nonce', async () => {
    const nonce = await createDiscordMessageNonce(
      'source-id',
      '123456789012345678',
    );

    expect(nonce).toBe('0a5fd9843e0a80dd22b5df050');
    await expect(
      createDiscordMessageNonce('source-id', '123456789012345678'),
    ).resolves.toBe(nonce);
    await expect(
      createDiscordMessageNonce('other-source', '123456789012345678'),
    ).resolves.not.toBe(nonce);
  });
});
