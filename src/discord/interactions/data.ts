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

export interface DiscordApplicationCommandData {
  name: string;
  options?: DiscordApplicationCommandOption[];
  resolved?: {
    roles?: Record<string, { mentionable?: boolean }>;
  };
}

export interface DiscordInteraction {
  type: number;
  application_id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { type: number };
  app_permissions?: string;
  member?: { permissions?: string };
  data?: DiscordApplicationCommandData;
}

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
