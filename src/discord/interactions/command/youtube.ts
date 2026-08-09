import {
  cacheYouTubeChannelTitle,
  getCachedYouTubeChannelTitles,
  type GuildYouTubeSubscription,
  listChannelYouTubeSubscriptions,
  listGuildYouTubeSubscriptions,
} from '../../../youtube-subscription/index';
import { toLoggableError } from '../../../log';
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
  type DiscordApplicationCommandOption,
  type DiscordInteraction,
  getInteractionString,
} from '../data';
import { escapeDiscordMarkdown } from '../../markdown';
import type { DiscordMentionTarget } from '../../message';
import {
  hasDiscordPermission,
  MANAGE_GUILD_PERMISSION,
} from '../../permission';
import { parseDiscordSnowflake, type DiscordSnowflake } from '../../snowflake';
import {
  canPostInChannel,
  createPingDescription,
  isSupportedNotificationChannel,
  parseNotificationCommand,
  resolveNotificationPing,
} from './notification';
import youtubeCommand from './youtube.json';

export const YOUTUBE_COMMAND_NAME = youtubeCommand.name;

interface YouTubeAddOptions {
  youtube: string;
  message?: string;
  ping?: DiscordMentionTarget;
  roleId?: DiscordSnowflake;
}

/** Handles the authenticated `/youtube` application command. */
export async function handleYouTubeCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const command = parseNotificationCommand(
    interaction.data,
    YOUTUBE_COMMAND_NAME,
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
  ping: DiscordMentionTarget | undefined,
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

function parseYouTubeAddOptions(
  values: readonly DiscordApplicationCommandOption[],
): YouTubeAddOptions | string {
  let youtube: string | undefined;
  let message: string | undefined;
  let ping: DiscordMentionTarget | undefined;
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

function logTitleFailure(
  event: string,
  youtubeChannelId: string,
  error: unknown,
): void {
  console.warn({ event, youtubeChannelId, error: toLoggableError(error) });
}

function logInteractionFailure(error: unknown): void {
  console.error({
    event: 'discord_interaction_failed',
    error: toLoggableError(error),
  });
}
