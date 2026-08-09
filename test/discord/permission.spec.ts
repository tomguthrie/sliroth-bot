import { describe, expect, it } from 'vitest';

import {
  hasDiscordPermission,
  MANAGE_GUILD_PERMISSION,
} from '../../src/discord/permission';

describe('Discord permissions', () => {
  it('accepts the requested permission', () => {
    expect(
      hasDiscordPermission(
        MANAGE_GUILD_PERMISSION.toString(),
        MANAGE_GUILD_PERMISSION,
      ),
    ).toBe(true);
  });

  it('accepts Administrator for every permission', () => {
    expect(hasDiscordPermission('8', MANAGE_GUILD_PERMISSION)).toBe(true);
  });

  it.each([undefined, '', 'invalid', '0'])(
    'rejects an absent or invalid permission value: %s',
    (value) => {
      expect(hasDiscordPermission(value, MANAGE_GUILD_PERMISSION)).toBe(false);
    },
  );
});
