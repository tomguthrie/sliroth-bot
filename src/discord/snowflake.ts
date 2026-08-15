import * as z from 'zod';

/** A Discord identifier represented as a decimal string. */
export const DiscordSnowflake = z.string().regex(/^\d{17,20}$/);

export type DiscordSnowflake = z.infer<typeof DiscordSnowflake>;

/** Returns whether a string is a Discord snowflake. */
export function isDiscordSnowflake(value: string): boolean {
  return DiscordSnowflake.safeParse(value).success;
}
