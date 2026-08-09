import { describe, expect, it } from 'vitest';

import {
  createDiscordMention,
  createDiscordNonce,
} from '../../src/discord/message';

describe('Discord notification messages', () => {
  it('omits an absent mention', () => {
    expect(createDiscordMention(null)).toEqual({});
  });

  it.each(['everyone', 'here'] as const)('enables an @%s mention', (target) => {
    expect(createDiscordMention(target)).toEqual({
      content: `@${target}`,
      allowedMentions: { everyone: true },
    });
  });

  it('enables one role mention', () => {
    expect(createDiscordMention('123456789012345678')).toEqual({
      content: '<@&123456789012345678>',
      allowedMentions: { roleIds: ['123456789012345678'] },
    });
  });

  it('creates a deterministic bounded nonce', async () => {
    const nonce = await createDiscordNonce('source-id', '123456789012345678');

    expect(nonce).toBe('0a5fd9843e0a80dd22b5df050');
    await expect(
      createDiscordNonce('source-id', '123456789012345678'),
    ).resolves.toBe(nonce);
    await expect(
      createDiscordNonce('other-source', '123456789012345678'),
    ).resolves.not.toBe(nonce);
  });
});
