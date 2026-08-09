import {
  listChannelTwitchSubscriptions,
  listGuildTwitchSubscriptions,
} from '../../../twitch-subscription/index';
import type { TwitchSubscriber } from '../../../twitch-subscription/durable-object';
import {
  resolveTwitchChannel,
  TwitchChannelResolutionError,
} from '../../../twitch/channel';
import { createTwitchApiClient } from '../../../twitch/client';
import { escapeDiscordMarkdown } from '../../markdown';
import type { DiscordMentionTarget } from '../../message';
import {
  EMBED_LINKS_PERMISSION,
  hasDiscordPermission,
  MANAGE_GUILD_PERMISSION,
} from '../../permission';
import { parseDiscordSnowflake, type DiscordSnowflake } from '../../snowflake';
import {
  APPLICATION_COMMAND_OPTION_TYPE,
  type DiscordApplicationCommandOption,
  type DiscordInteraction,
  getInteractionString,
} from '../data';
import {
  deferredEphemeralInteractionResponse,
  editInteractionResponse,
  ephemeralInteractionResponse,
} from '../response';
import twitchCommand from './twitch.json';
import {
  canPostInChannel,
  createPingDescription,
  isSupportedNotificationChannel,
  parseNotificationCommand,
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

/** Handles the authenticated `/twitch` application command. */
export async function handleTwitchCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const command = parseNotificationCommand(
    interaction.data,
    TWITCH_COMMAND_NAME,
  );
  if (command === undefined) {
    return ephemeralInteractionResponse('This interaction is not supported.');
  }

  const guildId = parseDiscordSnowflake(interaction.guild_id);
  const channelId = parseDiscordSnowflake(interaction.channel_id);
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
    if (!isSupportedNotificationChannel(interaction.channel)) {
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

    const applicationId = parseDiscordSnowflake(interaction.application_id);
    const token = getInteractionString(interaction.token);
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
    const indexed = await listGuildTwitchSubscriptions(
      env.TWITCH_SUBSCRIPTIONS_INDEX,
      guildId,
    );
    if (indexed.length === 0) {
      return ephemeralInteractionResponse(
        'No Twitch notifications are configured for this server.',
      );
    }
    const broadcasterIds = Array.from(
      new Set(indexed.map(({ twitchBroadcasterId }) => twitchBroadcasterId)),
    );
    const subscriptions = (
      await Promise.all(
        broadcasterIds.map((broadcasterId) =>
          env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId).listSubscribers(
            guildId,
          ),
        ),
      )
    ).flat();
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
  token: string,
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

    const mention = createPingDescription(ping);
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
  token: string,
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
  subscriptions: readonly TwitchSubscriber[],
  currentChannelId: string,
): string {
  const sorted = [...subscriptions].sort((left, right) => {
    const leftCurrent = left.channelId === currentChannelId;
    const rightCurrent = right.channelId === currentChannelId;
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;

    return (
      left.broadcasterDisplayName.localeCompare(
        right.broadcasterDisplayName,
        'en',
        { sensitivity: 'base' },
      ) ||
      left.channelId.localeCompare(right.channelId) ||
      left.broadcasterId.localeCompare(right.broadcasterId)
    );
  });

  return [
    '**Twitch notifications in this server**',
    ...sorted.map((subscription) => {
      const current = subscription.channelId === currentChannelId;
      const marker = current ? '⭐' : '•';
      const currentLabel = current ? ' **— current channel**' : '';
      const name = escapeDiscordMarkdown(subscription.broadcasterDisplayName);
      const url = `https://www.twitch.tv/${encodeURIComponent(subscription.broadcasterLogin)}`;
      return `${marker} [${name}](${url}) → <#${subscription.channelId}>${currentLabel}`;
    }),
  ].join('\n');
}

function parseTwitchAddOptions(
  values: readonly DiscordApplicationCommandOption[],
): TwitchAddOptions | string {
  let twitch: string | undefined;
  let message: string | undefined;
  let offline: string | undefined;
  let ping: DiscordMentionTarget | undefined;
  let roleId: DiscordSnowflake | undefined;
  const names = new Set<string>();

  for (const value of values) {
    if (value.name === '' || names.has(value.name)) {
      return 'This interaction is not supported.';
    }
    names.add(value.name);

    if (
      value.name === 'twitch' &&
      value.type === APPLICATION_COMMAND_OPTION_TYPE.string
    ) {
      const input = getInteractionString(value.value)?.trim();
      twitch = input === '' ? undefined : input;
    } else if (
      (value.name === 'message' || value.name === 'offline') &&
      value.type === APPLICATION_COMMAND_OPTION_TYPE.string
    ) {
      const input = getInteractionString(value.value)?.trim();
      if (value.name === 'message') message = input === '' ? undefined : input;
      else offline = input === '' ? undefined : input;
    } else if (
      value.name === 'ping' &&
      value.type === APPLICATION_COMMAND_OPTION_TYPE.string &&
      (value.value === 'everyone' || value.value === 'here')
    ) {
      ping = value.value;
    } else if (
      value.name === 'role' &&
      value.type === APPLICATION_COMMAND_OPTION_TYPE.role
    ) {
      const input = parseDiscordSnowflake(value.value);
      if (input === undefined) return 'This interaction is not supported.';
      roleId = input;
    } else {
      return 'This interaction is not supported.';
    }
  }

  if (twitch === undefined) return 'A Twitch channel is required.';
  if (roleId !== undefined && ping !== undefined) {
    return 'Choose either a role or an @everyone/@here ping, not both.';
  }
  return { twitch, message, offline, ping, roleId };
}

function logInteractionFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      event: 'discord_interaction_failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
