import * as z from 'zod';

import {
  type GuildYouTubeSubscription,
  listChannelYouTubeSubscriptions,
  listGuildYouTubeSubscriptions,
} from '../../../youtube-subscription/index';
import { toLoggableError } from '../../../log';
import {
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
  type DiscordInteraction,
  type DiscordInteractionToken,
} from '../data';
import { escapeDiscordMarkdown } from '../../markdown';
import {
  describeDiscordMention,
  type DiscordMentionTarget,
} from '../../message';
import {
  hasDiscordPermission,
  MANAGE_GUILD_PERMISSION,
} from '../../permission';
import { DiscordSnowflake } from '../../snowflake';
import {
  canPostInChannel,
  DiscordNotificationCommand,
  DiscordNotificationChannel,
  resolveNotificationPing,
} from './notification';
import youtubeCommand from './youtube.json';

export const YOUTUBE_COMMAND_NAME = youtubeCommand.name;

const TrimmedString = z.string().transform((value) => value.trim());

const YouTubeAddCommandOption = z.discriminatedUnion('name', [
  z.object({
    type: z.literal(APPLICATION_COMMAND_OPTION_TYPE.string),
    name: z.literal('youtube'),
    value: TrimmedString,
  }),
  z.object({
    type: z.literal(APPLICATION_COMMAND_OPTION_TYPE.string),
    name: z.literal('message'),
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

const YouTubeAddOptions = z
  .array(YouTubeAddCommandOption)
  .refine(
    (options) =>
      new Set(options.map((option) => option.name)).size === options.length,
  )
  .transform((options) =>
    Object.fromEntries(
      options.map(({ name, value }) => [
        name === 'role' ? 'roleId' : name,
        value,
      ]),
    ),
  )
  .pipe(
    z.object({
      youtube: z.string().min(1),
      message: z
        .string()
        .transform((value) => (value === '' ? undefined : value))
        .optional(),
      ping: z.enum(['everyone', 'here']).optional(),
      roleId: DiscordSnowflake.optional(),
    }),
  );

type YouTubeAddOptions = z.infer<typeof YouTubeAddOptions>;

/** Handles the authenticated `/youtube` application command. */
export async function handleYouTubeCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = DiscordNotificationCommand.safeParse(interaction.data);
  if (!result.success || result.data.commandName !== YOUTUBE_COMMAND_NAME) {
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
        'YouTube notifications can only be configured in a text or announcement channel.',
      );
    }
    if (!canPostInChannel(interaction.app_permissions)) {
      return ephemeralInteractionResponse(
        'I need View Channel and Send Messages permissions in this channel.',
      );
    }

    const applicationId = interaction.application_id;
    const token = interaction.token;
    if (applicationId === undefined || token === undefined) {
      return ephemeralInteractionResponse('This interaction is not supported.');
    }

    if (command.name === 'add') {
      const optionsResult = YouTubeAddOptions.safeParse(command.options);
      if (!optionsResult.success) {
        return ephemeralInteractionResponse(
          'This interaction is not supported.',
        );
      }
      const options = optionsResult.data;
      if (options.roleId !== undefined && options.ping !== undefined) {
        return ephemeralInteractionResponse(
          'Choose either a role or an @everyone/@here ping, not both.',
        );
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

    return ephemeralInteractionResponse(
      createYouTubeListContent(subscriptions, channelId),
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
  token: DiscordInteractionToken,
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
      channelTitle: channel.title,
      message: options.message,
      ping,
    });

    const mention = describeDiscordMention(ping);
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
  token: DiscordInteractionToken,
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

function createYouTubeListContent(
  subscriptions: readonly GuildYouTubeSubscription[],
  currentChannelId: string,
): string {
  const sorted = [...subscriptions].sort((left, right) => {
    const leftCurrent = left.discordChannelId === currentChannelId;
    const rightCurrent = right.discordChannelId === currentChannelId;
    if (leftCurrent !== rightCurrent) {
      return leftCurrent ? -1 : 1;
    }

    const titleOrder = left.youtubeChannelTitle.localeCompare(
      right.youtubeChannelTitle,
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
    createSubscriptionLine(subscription, currentChannelId),
  );
  return ['**YouTube notifications in this server**', ...lines].join('\n');
}

function createSubscriptionLine(
  subscription: GuildYouTubeSubscription,
  currentChannelId: string,
): string {
  const current = subscription.discordChannelId === currentChannelId;
  const marker = current ? '⭐' : '•';
  const currentLabel = current ? ' **— current channel**' : '';
  const title = escapeDiscordMarkdown(subscription.youtubeChannelTitle);
  const channelUrl = `https://www.youtube.com/channel/${encodeURIComponent(
    subscription.youtubeChannelId,
  )}`;
  return `${marker} [${title}](${channelUrl}) → <#${subscription.discordChannelId}>${currentLabel}`;
}

function logInteractionFailure(error: unknown): void {
  console.error({
    event: 'discord_interaction_failed',
    error: toLoggableError(error),
  });
}
