import { describe, expect, it } from 'vitest';

import { DiscordSnowflake } from '../../src/discord/snowflake';

describe('DiscordSnowflake', () => {
  it.each([
    '123456789012345678',
    '18446744073709551615',
    '18446744073709551616',
  ])('parses a Discord snowflake into its branded type: %s', (value) => {
    const snowflake: DiscordSnowflake = DiscordSnowflake.parse(value);

    expect(snowflake).toBe(value);
  });

  it.each(['1234567890123456', '123456789012345678901', 'not-a-snowflake'])(
    'rejects an invalid Discord snowflake: %s',
    (value) => {
      expect(DiscordSnowflake.safeParse(value).success).toBe(false);
    },
  );
});
