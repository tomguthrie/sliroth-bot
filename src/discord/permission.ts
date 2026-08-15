import { ChannelTypes } from 'discord-interactions';

import type { DiscordInteraction } from './interaction';
import {
  createEphemeralResponse,
  unsupportedInteractionResponse,
} from './interaction';
import type { DiscordMentionTarget } from './message';

const ADMINISTRATOR_PERMISSION = 1n << 3n;
const MANAGE_GUILD_PERMISSION = 1n << 5n;
const VIEW_CHANNEL_PERMISSION = 1n << 10n;
const SEND_MESSAGES_PERMISSION = 1n << 11n;
export const EMBED_LINKS_PERMISSION = 1n << 14n;
const MENTION_EVERYONE_PERMISSION = 1n << 17n;

export interface DiscordCommandContext {
  applicationId: string;
  token: string;
  guildId: string;
  channelId: string;
}

/** Validates the context shared by notification commands. */
export function getCommandContext(
  interaction: DiscordInteraction,
): DiscordCommandContext | Response {
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  if (guildId === undefined || channelId === undefined) {
    return createEphemeralResponse(
      'This command can only be used in a server.',
    );
  }
  if (
    !hasDiscordPermission(
      interaction.member?.permissions,
      MANAGE_GUILD_PERMISSION,
    )
  ) {
    return createEphemeralResponse(
      'You need the Manage Server permission to use this command.',
    );
  }

  const applicationId = interaction.application_id;
  const token = interaction.token;
  if (applicationId === undefined || token === undefined) {
    return unsupportedInteractionResponse();
  }
  return { applicationId, token, guildId, channelId };
}

export function isNotificationChannel(
  interaction: DiscordInteraction,
): boolean {
  return (
    interaction.channel?.type === ChannelTypes.GUILD_TEXT ||
    interaction.channel?.type === ChannelTypes.GUILD_ANNOUNCEMENT
  );
}

export function canPostInChannel(permissions: string | undefined): boolean {
  return (
    hasDiscordPermission(permissions, VIEW_CHANNEL_PERMISSION) &&
    hasDiscordPermission(permissions, SEND_MESSAGES_PERMISSION)
  );
}

export function hasDiscordPermission(
  value: string | undefined,
  permission: bigint,
): boolean {
  if (value === undefined) return false;
  const permissions = BigInt(value);
  return (
    (permissions & permission) !== 0n ||
    (permissions & ADMINISTRATOR_PERMISSION) !== 0n
  );
}

/** Resolves the mention selected by a notification add command. */
export function resolveNotificationPing(
  options: { ping?: 'everyone' | 'here'; roleId?: string },
  interaction: DiscordInteraction,
  guildId: string,
): { ping?: DiscordMentionTarget } | { error: string } {
  if (options.ping !== undefined) {
    return hasDiscordPermission(
      interaction.app_permissions,
      MENTION_EVERYONE_PERMISSION,
    )
      ? { ping: options.ping }
      : { error: 'I need Mention Everyone permission to use that ping.' };
  }
  if (options.roleId === undefined) return {};
  if (options.roleId === guildId) {
    return hasDiscordPermission(
      interaction.app_permissions,
      MENTION_EVERYONE_PERMISSION,
    )
      ? { ping: 'everyone' }
      : { error: 'I need Mention Everyone permission to mention @everyone.' };
  }

  const role = interaction.data?.resolved?.roles?.[options.roleId];
  if (role === undefined) {
    return { error: 'The selected Discord role could not be resolved.' };
  }
  if (
    role.mentionable !== true &&
    !hasDiscordPermission(
      interaction.app_permissions,
      MENTION_EVERYONE_PERMISSION,
    )
  ) {
    return {
      error: 'I need Mention Everyone permission to mention that role.',
    };
  }
  return { ping: options.roleId };
}
