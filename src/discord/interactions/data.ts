import * as z from 'zod';

import { DiscordPermissions } from '../permission';
import { DiscordSnowflake } from '../snowflake';

export const APPLICATION_COMMAND_OPTION_TYPE = {
  subcommand: 1,
  string: 3,
  role: 8,
} as const;

export const DiscordApplicationCommandOption = z.object({
  type: z.number(),
  name: z.string(),
  value: z.string().optional(),
  get options() {
    return z.array(DiscordApplicationCommandOption).optional();
  },
});

export type DiscordApplicationCommandOption = z.infer<
  typeof DiscordApplicationCommandOption
>;

const DiscordResolvedRole = z.object({
  mentionable: z.boolean().optional(),
});

type DiscordResolvedRole = z.infer<typeof DiscordResolvedRole>;

export const DiscordApplicationCommandData = z.object({
  name: z.string(),
  options: z.array(DiscordApplicationCommandOption).optional(),
  resolved: z
    .object({
      roles: z.record(DiscordSnowflake, DiscordResolvedRole).optional(),
    })
    .optional(),
});

export type DiscordApplicationCommandData = z.infer<
  typeof DiscordApplicationCommandData
>;

/** A non-empty token authorizing interaction follow-up requests. */
export const DiscordInteractionToken = z
  .string()
  .min(1)
  .brand<'DiscordInteractionToken'>();

export type DiscordInteractionToken = z.infer<typeof DiscordInteractionToken>;

/** Validates a Discord interaction received from the webhook boundary. */
export const DiscordInteraction = z.object({
  type: z.number(),
  application_id: DiscordSnowflake.optional(),
  token: DiscordInteractionToken.optional(),
  guild_id: DiscordSnowflake.optional(),
  channel_id: DiscordSnowflake.optional(),
  channel: z.object({ type: z.number() }).optional(),
  app_permissions: DiscordPermissions.optional(),
  member: z.object({ permissions: DiscordPermissions.optional() }).optional(),
  data: DiscordApplicationCommandData.optional(),
});

export type DiscordInteraction = z.infer<typeof DiscordInteraction>;

/** Reads a resolved role from application-command interaction data. */
export function getResolvedInteractionRole(
  data: DiscordApplicationCommandData | undefined,
  roleId: DiscordSnowflake,
): DiscordResolvedRole | undefined {
  return data?.resolved?.roles?.[roleId];
}
