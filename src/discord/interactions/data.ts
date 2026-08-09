import * as z from 'zod';

import type { DiscordSnowflake } from '../snowflake';

export const APPLICATION_COMMAND_OPTION_TYPE = {
  subcommand: 1,
  string: 3,
  role: 8,
} as const;

export interface DiscordApplicationCommandOption {
  type: number;
  name: string;
  value?: string;
  options?: DiscordApplicationCommandOption[];
}

export const DiscordApplicationCommandOption: z.ZodType<DiscordApplicationCommandOption> =
  z.lazy(() =>
    z.object({
      type: z.number(),
      name: z.string(),
      value: z.string().optional(),
      options: z.array(DiscordApplicationCommandOption).optional(),
    }),
  );

export const DiscordApplicationCommandData = z.object({
  name: z.string(),
  options: z.array(DiscordApplicationCommandOption).optional(),
  resolved: z
    .object({
      roles: z
        .record(z.string(), z.object({ mentionable: z.boolean().optional() }))
        .optional(),
    })
    .optional(),
});

export type DiscordApplicationCommandData = z.infer<
  typeof DiscordApplicationCommandData
>;

/** Validates a Discord interaction received from the webhook boundary. */
export const DiscordInteraction = z.object({
  type: z.number(),
  application_id: z.string().optional(),
  token: z.string().optional(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  channel: z.object({ type: z.number() }).optional(),
  app_permissions: z.string().optional(),
  member: z.object({ permissions: z.string().optional() }).optional(),
  data: DiscordApplicationCommandData.optional(),
});

export type DiscordInteraction = z.infer<typeof DiscordInteraction>;

/** Reads a non-empty string from an interaction payload. */
export function getInteractionString(value?: string): string | undefined {
  return value === '' ? undefined : value;
}

/** Reads a resolved role from application-command interaction data. */
export function getResolvedInteractionRole(
  data: DiscordApplicationCommandData | undefined,
  roleId: DiscordSnowflake,
): { mentionable?: boolean } | undefined {
  return data?.resolved?.roles?.[roleId];
}
