import { describe, expect, it } from 'vitest';

import {
  createDiscordMentionPayload,
  createDiscordMessageNonce,
  DiscordMentionTarget,
  isDiscordSnowflake,
} from '../../src/discord';
import { createNotificationList } from '../../src/discord/message';

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
    await expect(createDiscordMessageNonce('source-id', ROLE_ID)).resolves.toBe(nonce);
    await expect(createDiscordMessageNonce('source-id', '234567890123456789')).resolves.not.toBe(
      nonce,
    );
  });
});

describe('notification lists', () => {
  it('escapes optional details and preserves rows without details', () => {
    const item = { name: 'Channel *name*', channelId: ROLE_ID, providerId: 'provider' };
    expect(createNotificationList('Heading', [item], ROLE_ID)).toBe(
      `Heading\nChannel \\*name\\* → <#${ROLE_ID}>*`,
    );
    expect(
      createNotificationList('Heading', [{ ...item, detail: '*subscribed*' }], ROLE_ID),
    ).toContain(' — \\*subscribed\\*');
  });

  it('includes details in the message limit while preserving sorting and omitted counts', () => {
    const items = Array.from({ length: 80 }, (_, index) => ({
      name: `Channel ${String(index).padStart(2, '0')}`,
      channelId: ROLE_ID,
      providerId: String(index),
      detail: 'WebSub: subscribed',
    }));
    const result = createNotificationList('Heading', items.toReversed(), ROLE_ID);
    const lines = result.split('\n');
    const visible = lines.length - 2;
    expect(result.length).toBeLessThanOrEqual(2_000);
    expect(lines[1]).toContain('Channel 00');
    expect(lines[1]).toContain('WebSub: subscribed');
    expect(lines.at(-1)).toBe(`…and ${80 - visible} more.`);
  });
});
