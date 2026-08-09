const ADMINISTRATOR_PERMISSION = 1n << 3n;

export const MANAGE_GUILD_PERMISSION = 1n << 5n;
export const VIEW_CHANNEL_PERMISSION = 1n << 10n;
export const SEND_MESSAGES_PERMISSION = 1n << 11n;
export const EMBED_LINKS_PERMISSION = 1n << 14n;
export const MENTION_EVERYONE_PERMISSION = 1n << 17n;

/** Checks a Discord permission string, including Administrator. */
export function hasDiscordPermission(
  value: unknown,
  permission: bigint,
): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const permissions = BigInt(value);
    return (
      (permissions & permission) !== 0n ||
      (permissions & ADMINISTRATOR_PERMISSION) !== 0n
    );
  } catch {
    return false;
  }
}

/** Checks a permission on an interaction's partial guild member. */
export function interactionMemberHasPermission(
  member: unknown,
  permission: bigint,
): boolean {
  if (!isRecord(member)) {
    return false;
  }
  return hasDiscordPermission(member.permissions, permission);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
