import { describe, expect, it } from 'vitest';

import {
  createDiscordMentionPayload,
  createDiscordMessageNonce,
  DiscordMentionTarget,
  isDiscordSnowflake,
} from '../../src/discord';

const ROLE_ID = '123456789012345678';

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

  it('validates persisted mention targets at the boundary', () => {
    expect(DiscordMentionTarget.safeParse('everyone').success).toBe(true);
    expect(DiscordMentionTarget.safeParse(ROLE_ID).success).toBe(true);
    expect(DiscordMentionTarget.safeParse('not-a-role').success).toBe(false);
  });

  it('recognizes Discord snowflakes without branding strings', () => {
    expect(isDiscordSnowflake(ROLE_ID)).toBe(true);
    expect(isDiscordSnowflake('123')).toBe(false);
  });

  it('creates a deterministic, channel-scoped nonce', async () => {
    const nonce = await createDiscordMessageNonce('source-id', ROLE_ID);

    expect(nonce).toHaveLength(25);
    await expect(createDiscordMessageNonce('source-id', ROLE_ID)).resolves.toBe(
      nonce,
    );
    await expect(
      createDiscordMessageNonce('source-id', '234567890123456789'),
    ).resolves.not.toBe(nonce);
  });
});
