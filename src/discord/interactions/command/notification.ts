import { ChannelTypes } from 'discord-interactions';

import type { DiscordMentionTarget } from '../../message';
import {
  hasDiscordPermission,
  MENTION_EVERYONE_PERMISSION,
  SEND_MESSAGES_PERMISSION,
  VIEW_CHANNEL_PERMISSION,
} from '../../permission';
import type { DiscordSnowflake } from '../../snowflake';
import {
  APPLICATION_COMMAND_OPTION_TYPE,
  type DiscordApplicationCommandData,
  type DiscordApplicationCommandOption,
  type DiscordInteraction,
  getResolvedInteractionRole,
} from '../data';

/** Parses the single subcommand expected by a notification command. */
export function parseNotificationCommand(
  value: DiscordApplicationCommandData | undefined,
  commandName: string,
):
  | { name: string; options: readonly DiscordApplicationCommandOption[] }
  | undefined {
  if (
    value?.name !== commandName ||
    !Array.isArray(value.options) ||
    value.options.length !== 1
  ) {
    return undefined;
  }

  const option = value.options[0];
  if (
    option.type !== APPLICATION_COMMAND_OPTION_TYPE.subcommand ||
    option.name === ''
  ) {
    return undefined;
  }

  return {
    name: option.name,
    options: Array.isArray(option.options) ? option.options : [],
  };
}

export function resolveNotificationPing(
  options: {
    ping?: DiscordMentionTarget;
    roleId?: DiscordSnowflake;
  },
  data: DiscordApplicationCommandData | undefined,
  guildId: string,
  permissions: string | undefined,
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

export function createPingDescription(
  ping: DiscordMentionTarget | undefined,
): string {
  if (ping === undefined) {
    return '';
  }
  if (ping === 'everyone' || ping === 'here') {
    return ` and mention @${ping}`;
  }
  return ` and mention <@&${ping}>`;
}

export function isSupportedNotificationChannel(
  value: DiscordInteraction['channel'],
): boolean {
  return (
    value?.type === Number(ChannelTypes.GUILD_TEXT) ||
    value?.type === Number(ChannelTypes.GUILD_ANNOUNCEMENT)
  );
}

export function canPostInChannel(permissions: string | undefined): boolean {
  return (
    hasDiscordPermission(permissions, VIEW_CHANNEL_PERMISSION) &&
    hasDiscordPermission(permissions, SEND_MESSAGES_PERMISSION)
  );
}
