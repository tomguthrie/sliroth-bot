import * as z from 'zod';

import {
  type GuildTwitchSubscription,
  listChannelTwitchSubscriptions,
  listGuildTwitchSubscriptions,
} from '../../../twitch-subscription/index';
import { toLoggableError } from '../../../log';
import {
  resolveTwitchChannel,
  TwitchChannelResolutionError,
} from '../../../twitch/channel';
import { createTwitchApiClient } from '../../../twitch/client';
import { escapeDiscordMarkdown } from '../../markdown';
import { DiscordMention, type DiscordMentionTarget } from '../../message';
import {
  EMBED_LINKS_PERMISSION,
  hasDiscordPermission,
  MANAGE_GUILD_PERMISSION,
} from '../../permission';
import { DiscordSnowflake } from '../../snowflake';
import {
  APPLICATION_COMMAND_OPTION_TYPE,
  type DiscordApplicationCommandOption,
  type DiscordInteraction,
  type DiscordInteractionToken,
} from '../data';
import {
  deferredEphemeralInteractionResponse,
  editInteractionResponse,
  ephemeralInteractionResponse,
} from '../response';
import twitchCommand from './twitch.json';
import {
  canPostInChannel,
  DiscordNotificationCommand,
  DiscordNotificationChannel,
  resolveNotificationPing,
} from './notification';

export const TWITCH_COMMAND_NAME = twitchCommand.name;

interface TwitchAddOptions {
  twitch: string;
  message?: string;
  offline?: string;
  ping?: DiscordMentionTarget;
  roleId?: DiscordSnowflake;
}

const TrimmedString = z.string().transform((value) => value.trim());

const TwitchAddCommandOption = z.discriminatedUnion('name', [
  z.object({
    type: z.literal(APPLICATION_COMMAND_OPTION_TYPE.string),
    name: z.literal('twitch'),
    value: TrimmedString,
  }),
  z.object({
    type: z.literal(APPLICATION_COMMAND_OPTION_TYPE.string),
    name: z.literal('message'),
    value: TrimmedString,
  }),
  z.object({
    type: z.literal(APPLICATION_COMMAND_OPTION_TYPE.string),
    name: z.literal('offline'),
    value: TrimmedString,
  }),
  z.object({
    type: z.literal(APPLICATION_COMMAND_OPTION_TYPE.string),
    name: z.literal('ping'),
    value: z.enum(['everyone', 'here']),
  }),
  z.object({
    type: z.literal(APPLICATION_COMMAND_OPTION_TYPE.role),
    name: z.literal('role'),
    value: DiscordSnowflake,
  }),
]);

const TwitchAddCommandOptions = z
  .array(TwitchAddCommandOption)
  .refine(
    (options) =>
      new Set(options.map((option) => option.name)).size === options.length,
  );

/** Handles the authenticated `/twitch` application command. */
export async function handleTwitchCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = DiscordNotificationCommand.safeParse(interaction.data);
  if (!result.success || result.data.commandName !== TWITCH_COMMAND_NAME) {
    return ephemeralInteractionResponse('This interaction is not supported.');
  }
  const command = result.data;

  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  if (guildId === undefined || channelId === undefined) {
    return ephemeralInteractionResponse(
      'This command can only be used in a server.',
    );
  }

  if (
    !hasDiscordPermission(
      interaction.member?.permissions,
      MANAGE_GUILD_PERMISSION,
    )
  ) {
    return ephemeralInteractionResponse(
      'You need the Manage Server permission to use this command.',
    );
  }

  if (command.name === 'add' || command.name === 'remove') {
    if (!DiscordNotificationChannel.safeParse(interaction.channel).success) {
      return ephemeralInteractionResponse(
        'Twitch notifications can only be configured in a text or announcement channel.',
      );
    }
    if (!canPostInChannel(interaction.app_permissions)) {
      return ephemeralInteractionResponse(
        'I need View Channel and Send Messages permissions in this channel.',
      );
    }
    if (
      command.name === 'add' &&
      !hasDiscordPermission(interaction.app_permissions, EMBED_LINKS_PERMISSION)
    ) {
      return ephemeralInteractionResponse(
        'I need Embed Links permission in this channel.',
      );
    }

    const applicationId = interaction.application_id;
    const token = interaction.token;
    if (applicationId === undefined || token === undefined) {
      return ephemeralInteractionResponse('This interaction is not supported.');
    }

    if (command.name === 'add') {
      const options = parseTwitchAddOptions(command.options);
      if (typeof options === 'string') {
        return ephemeralInteractionResponse(options);
      }
      const pingResult = resolveNotificationPing(
        options,
        interaction.data,
        guildId,
        interaction.app_permissions,
      );
      if ('error' in pingResult) {
        return ephemeralInteractionResponse(pingResult.error);
      }
      ctx.waitUntil(
        completeTwitchAdd(
          env,
          applicationId,
          token,
          guildId,
          channelId,
          options,
          pingResult.ping,
        ),
      );
    } else {
      if (command.options.length !== 0) {
        return ephemeralInteractionResponse(
          'This interaction is not supported.',
        );
      }
      ctx.waitUntil(completeTwitchRemove(env, applicationId, token, channelId));
    }

    return deferredEphemeralInteractionResponse();
  }

  if (command.name !== 'list' || command.options.length !== 0) {
    return ephemeralInteractionResponse('This interaction is not supported.');
  }

  try {
    const subscriptions = await listGuildTwitchSubscriptions(
      env.TWITCH_SUBSCRIPTIONS_INDEX,
      guildId,
    );
    if (subscriptions.length === 0) {
      return ephemeralInteractionResponse(
        'No Twitch notifications are configured for this server.',
      );
    }
    return ephemeralInteractionResponse(
      createTwitchListContent(subscriptions, channelId),
    );
  } catch (error) {
    logInteractionFailure(error);
    return ephemeralInteractionResponse(
      'Twitch notifications could not be loaded. Please try again.',
    );
  }
}

async function completeTwitchAdd(
  env: Env,
  applicationId: DiscordSnowflake,
  token: DiscordInteractionToken,
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  options: TwitchAddOptions,
  ping: DiscordMentionTarget | undefined,
): Promise<void> {
  try {
    const broadcaster = await resolveTwitchChannel(
      options.twitch,
      createTwitchApiClient(env),
    );
    await env.TWITCH_SUBSCRIPTIONS.getByName(broadcaster.id).addSubscriber(
      broadcaster,
      {
        guildId,
        channelId,
        message: options.message,
        offline: options.offline,
        ping,
      },
    );

    const mention = DiscordMention.describe(ping);
    await editInteractionResponse(
      applicationId,
      token,
      `Streams from **${escapeDiscordMarkdown(broadcaster.displayName)}** will be posted in <#${channelId}>${mention}.`,
    );
  } catch (error) {
    logInteractionFailure(error);
    const content =
      error instanceof TwitchChannelResolutionError
        ? 'That Twitch channel could not be resolved. Try its login, numeric broadcaster ID, or full channel URL.'
        : 'The Twitch notification could not be added. Please try again.';
    await editInteractionResponse(applicationId, token, content).catch(
      logInteractionFailure,
    );
  }
}

async function completeTwitchRemove(
  env: Env,
  applicationId: DiscordSnowflake,
  token: DiscordInteractionToken,
  channelId: DiscordSnowflake,
): Promise<void> {
  try {
    const broadcasterIds = await listChannelTwitchSubscriptions(
      env.TWITCH_SUBSCRIPTIONS_INDEX,
      channelId,
    );
    await Promise.all(
      broadcasterIds.map((broadcasterId) =>
        env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId).removeSubscriber(
          channelId,
        ),
      ),
    );
    const content =
      broadcasterIds.length === 0
        ? `No Twitch notifications were configured for <#${channelId}>.`
        : `Removed ${broadcasterIds.length} Twitch notification${broadcasterIds.length === 1 ? '' : 's'} from <#${channelId}>.`;
    await editInteractionResponse(applicationId, token, content);
  } catch (error) {
    logInteractionFailure(error);
    await editInteractionResponse(
      applicationId,
      token,
      'The Twitch notifications could not be removed. Please try again.',
    ).catch(logInteractionFailure);
  }
}

function createTwitchListContent(
  subscriptions: readonly GuildTwitchSubscription[],
  currentChannelId: string,
): string {
  const sorted = [...subscriptions].sort((left, right) => {
    const leftCurrent = left.discordChannelId === currentChannelId;
    const rightCurrent = right.discordChannelId === currentChannelId;
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;

    return (
      left.twitchBroadcasterDisplayName.localeCompare(
        right.twitchBroadcasterDisplayName,
        'en',
        { sensitivity: 'base' },
      ) ||
      left.discordChannelId.localeCompare(right.discordChannelId) ||
      left.twitchBroadcasterId.localeCompare(right.twitchBroadcasterId)
    );
  });

  return [
    '**Twitch notifications in this server**',
    ...sorted.map((subscription) => {
      const current = subscription.discordChannelId === currentChannelId;
      const marker = current ? '⭐' : '•';
      const currentLabel = current ? ' **— current channel**' : '';
      const name = escapeDiscordMarkdown(
        subscription.twitchBroadcasterDisplayName,
      );
      const url = `https://www.twitch.tv/${encodeURIComponent(subscription.twitchBroadcasterLogin)}`;
      return `${marker} [${name}](${url}) → <#${subscription.discordChannelId}>${currentLabel}`;
    }),
  ].join('\n');
}

function parseTwitchAddOptions(
  values: readonly DiscordApplicationCommandOption[],
): TwitchAddOptions | string {
  const result = TwitchAddCommandOptions.safeParse(values);
  if (!result.success) {
    return 'This interaction is not supported.';
  }

  let twitch: string | undefined;
  let message: string | undefined;
  let offline: string | undefined;
  let ping: DiscordMentionTarget | undefined;
  let roleId: DiscordSnowflake | undefined;

  for (const option of result.data) {
    switch (option.name) {
      case 'twitch':
        twitch = option.value === '' ? undefined : option.value;
        break;
      case 'message':
        message = option.value === '' ? undefined : option.value;
        break;
      case 'offline':
        offline = option.value === '' ? undefined : option.value;
        break;
      case 'ping':
        ping = option.value;
        break;
      case 'role':
        roleId = option.value;
        break;
    }
  }

  if (twitch === undefined) return 'A Twitch channel is required.';
  if (roleId !== undefined && ping !== undefined) {
    return 'Choose either a role or an @everyone/@here ping, not both.';
  }
  return { twitch, message, offline, ping, roleId };
}

function logInteractionFailure(error: unknown): void {
  console.error({
    event: 'discord_interaction_failed',
    error: toLoggableError(error),
  });
}
