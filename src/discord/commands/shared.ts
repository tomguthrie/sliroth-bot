import {
  ChannelTypes,
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import * as z from 'zod';

import { toLoggableError } from '../../log';
import { DISCORD_API_BASE_URL } from '../client';
import type { DiscordMentionTarget } from '../message';
import { DiscordSnowflake } from '../snowflake';

const ADMINISTRATOR_PERMISSION = 1n << 3n;
export const MANAGE_GUILD_PERMISSION = 1n << 5n;
const VIEW_CHANNEL_PERMISSION = 1n << 10n;
const SEND_MESSAGES_PERMISSION = 1n << 11n;
export const EMBED_LINKS_PERMISSION = 1n << 14n;
const MENTION_EVERYONE_PERMISSION = 1n << 17n;
const MAX_MESSAGE_CONTENT_LENGTH = 2_000;

const DiscordPermissions = z.string().regex(/^\d+$/);
const DiscordResolvedRole = z.object({ mentionable: z.boolean().optional() });

export const DiscordInteraction = z.object({
  type: z.number(),
  application_id: DiscordSnowflake.optional(),
  token: z.string().min(1).optional(),
  guild_id: DiscordSnowflake.optional(),
  channel_id: DiscordSnowflake.optional(),
  channel: z.object({ type: z.number() }).optional(),
  app_permissions: DiscordPermissions.optional(),
  member: z.object({ permissions: DiscordPermissions.optional() }).optional(),
  data: z
    .object({
      name: z.string(),
      options: z.array(z.unknown()).optional(),
      resolved: z
        .object({
          roles: z.record(DiscordSnowflake, DiscordResolvedRole).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type DiscordInteraction = z.infer<typeof DiscordInteraction>;

export interface DiscordCommandContext {
  applicationId: string;
  token: string;
  guildId: string;
  channelId: string;
}

export interface NotificationListItem {
  name: string;
  channelId: string;
  providerId: string;
}

/** Creates an immediate response visible only to the command invoker. */
export function createEphemeralResponse(content: string): Response {
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: InteractionResponseFlags.EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
}

/** Acknowledges a command whose final response will be written asynchronously. */
export function createDeferredResponse(): Response {
  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });
}

export function unsupportedInteractionResponse(): Response {
  return createEphemeralResponse('This interaction is not supported.');
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

/** Replaces the original response to a deferred interaction. */
export async function editInteractionResponse(
  applicationId: string,
  token: string,
  content: string,
): Promise<void> {
  const response = await fetch(
    new URL(
      `webhooks/${applicationId}/${encodeURIComponent(token)}/messages/@original`,
      DISCORD_API_BASE_URL,
    ),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    },
  );
  if (!response.ok) {
    if (response.body !== null) await response.body.cancel();
    throw new Error(
      `Discord interaction response returned HTTP ${response.status}`,
    );
  }
  if (response.body !== null) await response.body.cancel();
}

/** Produces a stable, preview-free subscription list within Discord's limit. */
export function createNotificationList(
  heading: string,
  items: readonly NotificationListItem[],
  currentChannelId: string,
): string {
  const rows = [...items]
    .sort((left, right) => {
      const leftCurrent = left.channelId === currentChannelId;
      const rightCurrent = right.channelId === currentChannelId;
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      return (
        left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) ||
        left.channelId.localeCompare(right.channelId) ||
        left.providerId.localeCompare(right.providerId)
      );
    })
    .map(
      ({ name, channelId }) =>
        `${escapeDiscordMarkdown(name)} → <#${channelId}>${channelId === currentChannelId ? '*' : ''}`,
    );

  const lines = [heading];
  for (const [index, row] of rows.entries()) {
    const omittedAfterRow = rows.length - index - 1;
    const candidate = [
      ...lines,
      row,
      ...(omittedAfterRow === 0 ? [] : [`…and ${omittedAfterRow} more.`]),
    ].join('\n');
    if (candidate.length > MAX_MESSAGE_CONTENT_LENGTH) {
      lines.push(`…and ${rows.length - index} more.`);
      break;
    }
    lines.push(row);
  }
  return lines.join('\n');
}

export function describeDiscordMention(
  ping: DiscordMentionTarget | undefined,
): string {
  if (ping === undefined) return '';
  if (ping === 'everyone' || ping === 'here') return ` and mention @${ping}`;
  return ` and mention <@&${ping}>`;
}

export function escapeDiscordMarkdown(value: string): string {
  return value.replaceAll(/([\\`*_{}[\]()<>#+\-.!|~])/g, '\\$1');
}

export function logCommandFailure(
  provider: 'twitch' | 'youtube',
  action: 'add' | 'list' | 'remove',
  context: Pick<DiscordCommandContext, 'guildId' | 'channelId'>,
  error: unknown,
): void {
  console.error({
    event: 'discord_interaction_failed',
    provider,
    action,
    guildId: context.guildId,
    channelId: context.channelId,
    error: toLoggableError(error),
  });
}
