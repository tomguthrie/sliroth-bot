import * as z from 'zod';

const ADMINISTRATOR_PERMISSION = 1n << 3n;

export const MANAGE_GUILD_PERMISSION = 1n << 5n;
export const VIEW_CHANNEL_PERMISSION = 1n << 10n;
export const SEND_MESSAGES_PERMISSION = 1n << 11n;
export const EMBED_LINKS_PERMISSION = 1n << 14n;
export const MENTION_EVERYONE_PERMISSION = 1n << 17n;

/** A decimal Discord permission bitfield received from the API. */
export const DiscordPermissions = z
  .string()
  .regex(/^[0-9]+$/)
  .brand<'DiscordPermissions'>();

export type DiscordPermissions = z.infer<typeof DiscordPermissions>;

/** Checks a validated Discord permission bitfield, including Administrator. */
export function hasDiscordPermission(
  value: DiscordPermissions | undefined,
  permission: bigint,
): boolean {
  if (value === undefined) {
    return false;
  }

  const permissions = BigInt(value);
  return (
    (permissions & permission) !== 0n ||
    (permissions & ADMINISTRATOR_PERMISSION) !== 0n
  );
}
