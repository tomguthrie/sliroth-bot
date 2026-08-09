import * as z from 'zod';

export const DiscordSnowflake = z
  .string()
  .regex(/^[0-9]{17,20}$/)
  .brand<'DiscordSnowflake'>();

export type DiscordSnowflake = z.infer<typeof DiscordSnowflake>;
