import type { DiscordSnowflake } from '../snowflake';

export const APPLICATION_COMMAND_OPTION_TYPE = {
  subcommand: 1,
  string: 3,
  role: 8,
} as const;

/** Reads a non-empty string from an interaction payload. */
export function getInteractionString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Reads a resolved role from application-command interaction data. */
export function getResolvedInteractionRole(
  data: unknown,
  roleId: DiscordSnowflake,
): Record<string, unknown> | undefined {
  if (!isInteractionRecord(data) || !isInteractionRecord(data.resolved)) {
    return undefined;
  }
  const roles = data.resolved.roles;
  if (!isInteractionRecord(roles)) {
    return undefined;
  }
  const role = roles[roleId];
  return isInteractionRecord(role) ? role : undefined;
}

/** Narrows an object embedded in an interaction payload. */
export function isInteractionRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
