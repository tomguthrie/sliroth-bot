import { describe, expect, it } from 'vitest';

import {
  createDiscordMention,
  createDiscordNonce,
} from '../../src/discord/message';
import { DiscordSnowflake } from '../../src/discord/snowflake';

const ROLE_ID = DiscordSnowflake.parse('123456789012345678');

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
    expect(createDiscordMention(ROLE_ID)).toEqual({
      content: `<@&${ROLE_ID}>`,
      allowedMentions: { roleIds: [ROLE_ID] },
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
