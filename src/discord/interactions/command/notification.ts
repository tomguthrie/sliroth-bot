import { ChannelTypes } from 'discord-interactions';
import * as z from 'zod';

import type { DiscordMentionTarget } from '../../message';
import {
  type DiscordPermissions,
  hasDiscordPermission,
  MENTION_EVERYONE_PERMISSION,
  SEND_MESSAGES_PERMISSION,
  VIEW_CHANNEL_PERMISSION,
} from '../../permission';
import type { DiscordSnowflake } from '../../snowflake';
import {
  APPLICATION_COMMAND_OPTION_TYPE,
  DiscordApplicationCommandOption,
  type DiscordApplicationCommandData,
  getResolvedInteractionRole,
} from '../data';

export const DiscordNotificationCommand = z
  .object({
    name: z.string(),
    options: z.tuple([
      z.object({
        type: z.literal(APPLICATION_COMMAND_OPTION_TYPE.subcommand),
        name: z.string().min(1),
        options: z.array(DiscordApplicationCommandOption).optional(),
      }),
    ]),
  })
  .transform(({ name: commandName, options: [subcommand] }) => ({
    commandName,
    name: subcommand.name,
    options: subcommand.options ?? [],
  }));

export type DiscordNotificationCommand = z.infer<
  typeof DiscordNotificationCommand
>;

/** Channel shapes supported for notification delivery. */
export const DiscordNotificationChannel = z.object({
  type: z.union([
    z.literal(Number(ChannelTypes.GUILD_TEXT)),
    z.literal(Number(ChannelTypes.GUILD_ANNOUNCEMENT)),
  ]),
});

export type DiscordNotificationChannel = z.infer<
  typeof DiscordNotificationChannel
>;

export function resolveNotificationPing(
  options: {
    ping?: DiscordMentionTarget;
    roleId?: DiscordSnowflake;
  },
  data: DiscordApplicationCommandData | undefined,
  guildId: DiscordSnowflake,
  permissions: DiscordPermissions | undefined,
): { ping?: DiscordMentionTarget } | { error: string } {
  if (options.ping !== undefined) {
    return hasDiscordPermission(permissions, MENTION_EVERYONE_PERMISSION)
      ? { ping: options.ping }
      : {
          error:
            'I need Mention Everyone permission to use @everyone or @here.',
        };
  }
  if (options.roleId === undefined) {
    return {};
  }
  if (options.roleId === guildId) {
    return hasDiscordPermission(permissions, MENTION_EVERYONE_PERMISSION)
      ? { ping: 'everyone' }
      : { error: 'I need Mention Everyone permission to mention @everyone.' };
  }

  const role = getResolvedInteractionRole(data, options.roleId);
  if (role === undefined) {
    return { error: 'The selected Discord role could not be resolved.' };
  }
  if (
    role.mentionable !== true &&
    !hasDiscordPermission(permissions, MENTION_EVERYONE_PERMISSION)
  ) {
    return {
      error: 'I need Mention Everyone permission to mention that role.',
    };
  }
  return { ping: options.roleId };
}

export function canPostInChannel(
  permissions: DiscordPermissions | undefined,
): boolean {
  return (
    hasDiscordPermission(permissions, VIEW_CHANNEL_PERMISSION) &&
    hasDiscordPermission(permissions, SEND_MESSAGES_PERMISSION)
  );
}
