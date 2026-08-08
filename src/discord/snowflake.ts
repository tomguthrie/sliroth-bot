const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;

export type DiscordSnowflake = `${bigint}`;

/** Checks and narrows a Discord snowflake received at a runtime boundary. */
export function isDiscordSnowflake(value: unknown): value is DiscordSnowflake {
  return typeof value === 'string' && DISCORD_SNOWFLAKE.test(value);
}

/** Returns a Discord snowflake received at a runtime boundary, if valid. */
export function parseDiscordSnowflake(
  value: unknown,
): DiscordSnowflake | undefined {
  return isDiscordSnowflake(value) ? value : undefined;
}

/** Requires a valid Discord snowflake at a runtime boundary. */
export function requireDiscordSnowflake(
  value: unknown,
  name: string,
): asserts value is DiscordSnowflake {
  if (!isDiscordSnowflake(value)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
}
