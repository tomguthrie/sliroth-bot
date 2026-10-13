import * as z from 'zod';

import {
  CommandOptions,
  createDeferredResponse,
  createEphemeralResponse,
  editInteractionResponse,
  logCommandFailure,
  reportCommandFailure,
  unsupportedInteractionResponse,
} from '../discord/interaction';
import type { DiscordCommandHandler, DiscordInteraction } from '../discord/interaction';
import {
  createNotificationList,
  describeDiscordMention,
  escapeDiscordMarkdown,
} from '../discord/message';
import type { NotificationListItem } from '../discord/message';
import {
  canPostInChannel,
  getCommandContext,
  isNotificationChannel,
  resolveNotificationPing,
} from '../discord/permission';
import type { DiscordCommandContext } from '../discord/permission';
import { DiscordSnowflake } from '../discord/snowflake';
import { toLoggableError } from '../log';
import { resolveYouTubeChannel } from './channel';
import youtubeCommand from './discord-command.json';
import { youtubeSubscriptionLookup } from './lookup';

const YOUTUBE_COMMAND_NAME = youtubeCommand.name;

const YouTubeAddOptions = CommandOptions.pipe(
  z
    .strictObject({
      youtube: z.string().trim().min(1),
      message: z.string().trim().min(1).optional(),
      ping: z.enum(['everyone', 'here']).optional(),
      role: DiscordSnowflake.optional(),
    })
    .refine(({ ping, role }) => ping === undefined || role === undefined, {
      message: 'Choose either ping or role',
    }),
);

const YouTubeAddCommand = z
  .object({
    type: z.literal(1),
    name: z.literal('add'),
    options: YouTubeAddOptions,
  })
  .transform(({ name, options }) => ({ name, options }));

const YouTubeListCommand = z
  .object({
    type: z.literal(1),
    name: z.literal('list'),
    options: z
      .array(
        z.object({
          type: z.literal(5),
          name: z.literal('status'),
          value: z.boolean(),
        }),
      )
      .max(1)
      .optional(),
  })
  .transform(({ name, options }) => ({ name, status: options?.[0]?.value ?? false }));

const YouTubeRemoveCommand = z
  .object({
    type: z.literal(1),
    name: z.literal('remove'),
    options: z.array(z.never()).max(0).optional(),
  })
  .transform(({ name }) => ({ name }));

const YouTubeCommand = z
  .object({
    name: z.literal(YOUTUBE_COMMAND_NAME),
    options: z.tuple([z.union([YouTubeAddCommand, YouTubeListCommand, YouTubeRemoveCommand])]),
  })
  .transform(({ options: [command] }) => command);

/** Handles the authenticated `/youtube` application command. */
async function handleYouTubeCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const parsed = YouTubeCommand.safeParse(interaction.data);
  if (!parsed.success) {
    return unsupportedInteractionResponse();
  }

  const context = getCommandContext(interaction);
  if (context instanceof Response) {
    return context;
  }
  const command = parsed.data;

  switch (command.name) {
    case 'add': {
      const permissionError = validateYouTubeAdd(interaction);
      if (permissionError !== undefined) {
        return createEphemeralResponse(permissionError);
      }
      const ping = resolveNotificationPing(command.options, interaction, context.guildId);
      if ('error' in ping) {
        return createEphemeralResponse(ping.error);
      }

      ctx.waitUntil(completeYouTubeAdd(env, context, command.options, ping.ping));
      return createDeferredResponse();
    }
    case 'remove':
      ctx.waitUntil(completeYouTubeRemove(env, context));
      return createDeferredResponse();
    case 'list':
      if (command.status) {
        ctx.waitUntil(completeYouTubeStatusList(env, context));
        return createDeferredResponse();
      }
      return listYouTubeSubscriptions(env, context);
  }
}

export const youtubeDiscordCommand: DiscordCommandHandler = {
  name: YOUTUBE_COMMAND_NAME,
  handle: handleYouTubeCommand,
};

function validateYouTubeAdd(interaction: DiscordInteraction): string | undefined {
  if (!isNotificationChannel(interaction)) {
    return 'YouTube notifications can only be added in a text or announcement channel.';
  }
  if (!canPostInChannel(interaction.app_permissions)) {
    return 'I need View Channel and Send Messages permissions in this channel.';
  }
  return undefined;
}

async function completeYouTubeAdd(
  env: Env,
  context: DiscordCommandContext,
  options: z.infer<typeof YouTubeAddOptions>,
  ping: string | undefined,
): Promise<void> {
  try {
    const channel = await resolveYouTubeChannel(options.youtube);
    if (channel === undefined) {
      await editInteractionResponse(
        context.applicationId,
        context.token,
        'That YouTube channel could not be resolved.',
      );
      return;
    }
    await env.YOUTUBE_SUBSCRIPTIONS.getByName(channel.id).addSubscriber({
      guildId: context.guildId,
      channelId: context.channelId,
      channelTitle: channel.title,
      message: options.message,
      ping,
    });
    await editInteractionResponse(
      context.applicationId,
      context.token,
      `Uploads from **${escapeDiscordMarkdown(channel.title)}** will be posted in <#${context.channelId}>${describeDiscordMention(ping)}.`,
    );
  } catch (error) {
    await reportCommandFailure(
      'youtube',
      context,
      'add',
      'The YouTube notification could not be added. Please try again.',
      error,
    );
  }
}

async function completeYouTubeRemove(env: Env, context: DiscordCommandContext): Promise<void> {
  try {
    const channelIds = await youtubeSubscriptionLookup.listChannel(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX,
      context.channelId,
    );
    await Promise.all(
      channelIds.map((channelId) =>
        env.YOUTUBE_SUBSCRIPTIONS.getByName(channelId).removeSubscriber(context.channelId),
      ),
    );
    const content =
      channelIds.length === 0
        ? `No YouTube notifications were configured for <#${context.channelId}>.`
        : `Removed ${channelIds.length} YouTube notification${channelIds.length === 1 ? '' : 's'} from <#${context.channelId}>.`;
    await editInteractionResponse(context.applicationId, context.token, content);
  } catch (error) {
    await reportCommandFailure(
      'youtube',
      context,
      'remove',
      'The YouTube notifications could not be removed. Please try again.',
      error,
    );
  }
}

async function listYouTubeSubscriptions(
  env: Env,
  context: DiscordCommandContext,
): Promise<Response> {
  try {
    return createEphemeralResponse(await createYouTubeSubscriptionList(env, context));
  } catch (error) {
    logCommandFailure('youtube', 'list', context, error);
    return createEphemeralResponse('YouTube notifications could not be loaded. Please try again.');
  }
}

async function completeYouTubeStatusList(env: Env, context: DiscordCommandContext): Promise<void> {
  try {
    const content = await createYouTubeSubscriptionList(env, context, true);
    await editInteractionResponse(context.applicationId, context.token, content);
  } catch (error) {
    await reportCommandFailure(
      'youtube',
      context,
      'list',
      'YouTube notifications could not be loaded. Please try again.',
      error,
    );
  }
}

async function createYouTubeSubscriptionList(
  env: Env,
  context: DiscordCommandContext,
  includeStatus = false,
): Promise<string> {
  const subscriptions = await youtubeSubscriptionLookup.listGuild(
    env.YOUTUBE_SUBSCRIPTIONS_INDEX,
    context.guildId,
  );
  if (subscriptions.length === 0) {
    return 'No YouTube notifications are configured for this server.';
  }

  const statuses = new Map<string, Pick<NotificationListItem, 'detail' | 'detailTimestamp'>>();
  if (includeStatus) {
    const channelIds = new Set(subscriptions.map(({ providerId }) => providerId));
    await Promise.all(
      [...channelIds].map(async (youtubeChannelId) => {
        try {
          const { status, nextAlarmAt } =
            await env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId).getWebSubStatus();
          const alarmLabel =
            status === 'subscribed' ? 'renewal' : status === null ? 'next alarm' : 'next retry';
          statuses.set(youtubeChannelId, {
            detail: `WebSub: ${status ?? 'no state'} — ${nextAlarmAt === null ? 'no alarm scheduled' : alarmLabel}`,
            ...(nextAlarmAt === null ? {} : { detailTimestamp: nextAlarmAt }),
          });
        } catch (error) {
          console.error({
            event: 'youtube_websub_status_failed',
            youtubeChannelId,
            error: toLoggableError(error),
          });
          statuses.set(youtubeChannelId, { detail: 'WebSub: unavailable' });
        }
      }),
    );
  }

  return createNotificationList(
    '**YouTube notifications in this server**',
    subscriptions.map(({ channelId, providerId, metadata }) => ({
      name: metadata.title,
      channelId,
      providerId,
      ...statuses.get(providerId),
    })),
    context.channelId,
  );
}
