import { describe, expect, it } from 'vitest';

import {
  DiscordPermissions,
  hasDiscordPermission,
  MANAGE_GUILD_PERMISSION,
} from '../../src/discord/permission';

describe('Discord permissions', () => {
  it('accepts the requested permission', () => {
    expect(
      hasDiscordPermission(
        DiscordPermissions.parse(MANAGE_GUILD_PERMISSION.toString()),
        MANAGE_GUILD_PERMISSION,
      ),
    ).toBe(true);
  });

  it('accepts Administrator for every permission', () => {
    expect(
      hasDiscordPermission(
        DiscordPermissions.parse('8'),
        MANAGE_GUILD_PERMISSION,
      ),
    ).toBe(true);
  });

  it.each([undefined, DiscordPermissions.parse('0')])(
    'rejects an absent or unset permission: %s',
    (value) => {
      expect(hasDiscordPermission(value, MANAGE_GUILD_PERMISSION)).toBe(false);
    },
  );

  it.each(['', 'invalid', '-1'])('rejects an invalid bitfield: %s', (value) => {
    expect(DiscordPermissions.safeParse(value).success).toBe(false);
  });
});
