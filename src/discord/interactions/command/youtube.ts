import type { SubscriberPing } from '../../../db/youtube-subscription/schema';
import { ChannelTypes } from 'discord-interactions';
import {
  cacheYouTubeChannelTitle,
  getCachedYouTubeChannelTitles,
  type GuildYouTubeSubscription,
  listChannelYouTubeSubscriptions,
  listGuildYouTubeSubscriptions,
} from '../../../youtube-subscription/index';
import {
  fetchYouTubeChannelTitle,
  resolveYouTubeChannel,
  YouTubeChannelResolutionError,
} from '../../../youtube/channel';
import {
  deferredEphemeralInteractionResponse,
  editInteractionResponse,
  ephemeralInteractionResponse,
} from '../response';
import {
  APPLICATION_COMMAND_OPTION_TYPE,
  type DiscordApplicationCommandData,
  type DiscordApplicationCommandOption,
  type DiscordInteraction,
  getInteractionString,
  getResolvedInteractionRole,
} from '../data';
import { escapeDiscordMarkdown } from '../../markdown';
import {
  hasDiscordPermission,
  MANAGE_GUILD_PERMISSION,
  MENTION_EVERYONE_PERMISSION,
  SEND_MESSAGES_PERMISSION,
  VIEW_CHANNEL_PERMISSION,
} from '../../permission';
import { parseDiscordSnowflake, type DiscordSnowflake } from '../../snowflake';
import youtubeCommand from './youtube.json';

export const YOUTUBE_COMMAND_NAME = youtubeCommand.name;

interface YouTubeAddOptions {
  youtube: string;
  message?: string;
  ping?: SubscriberPing;
  roleId?: DiscordSnowflake;
}

/** Handles the authenticated `/youtube` application command. */
export async function handleYouTubeCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const command = parseYouTubeCommand(interaction.data);
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
        'YouTube notifications can only be configured in a text or announcement channel.',
      );
    }
    if (!canPostInChannel(interaction.app_permissions)) {
      return ephemeralInteractionResponse(
        'I need View Channel and Send Messages permissions in this channel.',
      );
    }

    const applicationId = parseDiscordSnowflake(interaction.application_id);
    const token = getInteractionString(interaction.token);
    if (applicationId === undefined || token === undefined) {
      return ephemeralInteractionResponse('This interaction is not supported.');
    }

    if (command.name === 'add') {
      const options = parseYouTubeAddOptions(command.options);
      if (typeof options === 'string') {
        return ephemeralInteractionResponse(options);
      }

      const pingResult = resolveSubscriberPing(
        options,
        interaction.data,
        guildId,
        interaction.app_permissions,
      );
      if (pingResult.error !== undefined) {
        return ephemeralInteractionResponse(pingResult.error);
      }

      ctx.waitUntil(
        completeYouTubeAdd(
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
      ctx.waitUntil(
        completeYouTubeRemove(env, applicationId, token, channelId),
      );
    }

    return deferredEphemeralInteractionResponse();
  }

  if (command.name !== 'list' || command.options.length !== 0) {
    return ephemeralInteractionResponse('This interaction is not supported.');
  }

  try {
    const subscriptions = await listGuildYouTubeSubscriptions(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX,
      guildId,
    );
    if (subscriptions.length === 0) {
      return ephemeralInteractionResponse(
        'No YouTube notifications are configured for this server.',
      );
    }

    const titles = await getCachedYouTubeChannelTitles(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX,
      subscriptions.map((subscription) => subscription.youtubeChannelId),
    );
    const missingChannelIds = Array.from(
      new Set(
        subscriptions
          .map((subscription) => subscription.youtubeChannelId)
          .filter((youtubeChannelId) => !titles.has(youtubeChannelId)),
      ),
    );

    if (missingChannelIds.length > 0) {
      await resolveYouTubeChannelTitles(
        env.YOUTUBE_SUBSCRIPTIONS_INDEX,
        missingChannelIds,
        titles,
      );
    }

    return ephemeralInteractionResponse(
      createYouTubeListContent(subscriptions, titles, channelId),
    );
  } catch (error) {
    logInteractionFailure(error);
    return ephemeralInteractionResponse(
      'YouTube notifications could not be loaded. Please try again.',
    );
  }
}

async function completeYouTubeAdd(
  env: Env,
  applicationId: DiscordSnowflake,
  token: string,
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  options: YouTubeAddOptions,
  ping: SubscriberPing | undefined,
): Promise<void> {
  try {
    const channel = await resolveYouTubeChannel(options.youtube);
    await env.YOUTUBE_SUBSCRIPTIONS.getByName(channel.id).addSubscriber({
      guildId,
      channelId,
      message: options.message,
      ping,
    });
    try {
      await cacheYouTubeChannelTitle(
        env.YOUTUBE_SUBSCRIPTIONS_INDEX,
        channel.id,
        channel.title,
      );
    } catch (error) {
      logTitleFailure('youtube_channel_title_cache_failed', channel.id, error);
    }

    const mention = createPingDescription(ping);
    await editInteractionResponse(
      applicationId,
      token,
      `Uploads from **${escapeDiscordMarkdown(channel.title)}** will be posted in <#${channelId}>${mention}.`,
    );
  } catch (error) {
    logInteractionFailure(error);
    const content =
      error instanceof YouTubeChannelResolutionError
        ? 'That YouTube channel could not be resolved. Try its full channel ID (starting with `UC`) or `/channel/` URL.'
        : 'The YouTube notification could not be added. Please try again.';
    await editInteractionResponse(applicationId, token, content).catch(
      logInteractionFailure,
    );
  }
}

async function completeYouTubeRemove(
  env: Env,
  applicationId: DiscordSnowflake,
  token: string,
  channelId: DiscordSnowflake,
): Promise<void> {
  try {
    const youtubeChannelIds = await listChannelYouTubeSubscriptions(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX,
      channelId,
    );
    await Promise.all(
      youtubeChannelIds.map((youtubeChannelId) =>
        env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId).removeSubscriber(
          channelId,
        ),
      ),
    );

    const content =
      youtubeChannelIds.length === 0
        ? `No YouTube notifications were configured for <#${channelId}>.`
        : `Removed ${youtubeChannelIds.length} YouTube notification${youtubeChannelIds.length === 1 ? '' : 's'} from <#${channelId}>.`;
    await editInteractionResponse(applicationId, token, content);
  } catch (error) {
    logInteractionFailure(error);
    await editInteractionResponse(
      applicationId,
      token,
      'The YouTube notifications could not be removed. Please try again.',
    ).catch(logInteractionFailure);
  }
}

function createPingDescription(ping: SubscriberPing | undefined): string {
  if (ping === undefined) {
    return '';
  }
  if (ping === 'everyone' || ping === 'here') {
    return ` and mention @${ping}`;
  }
  return ` and mention <@&${ping}>`;
}

async function resolveYouTubeChannelTitles(
  index: KVNamespace,
  channelIds: readonly string[],
  titles: Map<string, string>,
): Promise<void> {
  await Promise.all(
    channelIds.map(async (channelId) => {
      try {
        const title = await fetchYouTubeChannelTitle(channelId);
        titles.set(channelId, title);
        try {
          await cacheYouTubeChannelTitle(index, channelId, title);
        } catch (error) {
          logTitleFailure(
            'youtube_channel_title_cache_failed',
            channelId,
            error,
          );
        }
      } catch (error) {
        logTitleFailure('youtube_channel_title_fetch_failed', channelId, error);
      }
    }),
  );
}

function createYouTubeListContent(
  subscriptions: readonly GuildYouTubeSubscription[],
  titles: ReadonlyMap<string, string>,
  currentChannelId: string,
): string {
  const sorted = [...subscriptions].sort((left, right) => {
    const leftCurrent = left.discordChannelId === currentChannelId;
    const rightCurrent = right.discordChannelId === currentChannelId;
    if (leftCurrent !== rightCurrent) {
      return leftCurrent ? -1 : 1;
    }

    const titleOrder = displayTitle(left, titles).localeCompare(
      displayTitle(right, titles),
      'en',
      { sensitivity: 'base' },
    );
    return (
      titleOrder ||
      left.discordChannelId.localeCompare(right.discordChannelId) ||
      left.youtubeChannelId.localeCompare(right.youtubeChannelId)
    );
  });

  const lines = sorted.map((subscription) =>
    createSubscriptionLine(subscription, titles, currentChannelId),
  );
  return ['**YouTube notifications in this server**', ...lines].join('\n');
}

function createSubscriptionLine(
  subscription: GuildYouTubeSubscription,
  titles: ReadonlyMap<string, string>,
  currentChannelId: string,
): string {
  const current = subscription.discordChannelId === currentChannelId;
  const marker = current ? '⭐' : '•';
  const currentLabel = current ? ' **— current channel**' : '';
  const title = escapeDiscordMarkdown(displayTitle(subscription, titles));
  const channelUrl = `https://www.youtube.com/channel/${encodeURIComponent(
    subscription.youtubeChannelId,
  )}`;
  return `${marker} [${title}](${channelUrl}) → <#${subscription.discordChannelId}>${currentLabel}`;
}

function displayTitle(
  subscription: GuildYouTubeSubscription,
  titles: ReadonlyMap<string, string>,
): string {
  return (
    titles.get(subscription.youtubeChannelId) ?? subscription.youtubeChannelId
  );
}

function parseYouTubeCommand(
  value: DiscordApplicationCommandData | undefined,
): { name: string; options: DiscordApplicationCommandOption[] } | undefined {
  if (value?.name !== YOUTUBE_COMMAND_NAME) {
    return undefined;
  }
  if (!Array.isArray(value.options) || value.options.length !== 1) {
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

function parseYouTubeAddOptions(
  values: readonly DiscordApplicationCommandOption[],
): YouTubeAddOptions | string {
  let youtube: string | undefined;
  let message: string | undefined;
  let ping: SubscriberPing | undefined;
  let roleId: DiscordSnowflake | undefined;
  const names = new Set<string>();

  for (const value of values) {
    if (value.name === '' || names.has(value.name)) {
      return 'This interaction is not supported.';
    }
    names.add(value.name);

    if (
      value.name === 'youtube' &&
      value.type === APPLICATION_COMMAND_OPTION_TYPE.string
    ) {
      const input = getInteractionString(value.value)?.trim();
      youtube = input === '' ? undefined : input;
    } else if (
      value.name === 'message' &&
      value.type === APPLICATION_COMMAND_OPTION_TYPE.string
    ) {
      const input = getInteractionString(value.value)?.trim();
      message = input === '' ? undefined : input;
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
      if (input === undefined) {
        return 'This interaction is not supported.';
      }
      roleId = input;
    } else {
      return 'This interaction is not supported.';
    }
  }

  if (youtube === undefined) {
    return 'A YouTube channel is required.';
  }
  if (roleId !== undefined && ping !== undefined) {
    return 'Choose either a role or an @everyone/@here ping, not both.';
  }
  return { youtube, message, ping, roleId };
}

function resolveSubscriberPing(
  options: YouTubeAddOptions,
  data: DiscordApplicationCommandData | undefined,
  guildId: string,
  permissions: string | undefined,
): { ping?: SubscriberPing; error?: string } {
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

function isSupportedNotificationChannel(
  value: DiscordInteraction['channel'],
): boolean {
  if (value === undefined) return false;
  return (
    value.type === Number(ChannelTypes.GUILD_TEXT) ||
    value.type === Number(ChannelTypes.GUILD_ANNOUNCEMENT)
  );
}

function canPostInChannel(value: string | undefined): boolean {
  return (
    hasDiscordPermission(value, VIEW_CHANNEL_PERMISSION) &&
    hasDiscordPermission(value, SEND_MESSAGES_PERMISSION)
  );
}

function logTitleFailure(
  event: string,
  youtubeChannelId: string,
  error: unknown,
): void {
  console.warn(
    JSON.stringify({
      event,
      youtubeChannelId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function logInteractionFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      event: 'discord_interaction_failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
