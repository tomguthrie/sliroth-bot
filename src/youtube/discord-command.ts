import * as z from 'zod';

import { DiscordSnowflake } from '../discord/snowflake';
import {
  createDeferredResponse,
  createEphemeralResponse,
  editInteractionResponse,
  logCommandFailure,
  unsupportedInteractionResponse,
} from '../discord/interaction';
import type {
  DiscordCommandHandler,
  DiscordInteraction,
} from '../discord/interaction';
import {
  createNotificationList,
  describeDiscordMention,
  escapeDiscordMarkdown,
} from '../discord/message';
import {
  canPostInChannel,
  getCommandContext,
  isNotificationChannel,
  resolveNotificationPing,
} from '../discord/permission';
import type { DiscordCommandContext } from '../discord/permission';
import { resolveYouTubeChannel } from './channel';
import {
  listChannelYouTubeSubscriptions,
  listGuildYouTubeSubscriptions,
} from './subscription/index';
import youtubeCommand from './discord-command.json';

const YOUTUBE_COMMAND_NAME = youtubeCommand.name;

const YouTubeAddOption = z.discriminatedUnion('name', [
  z.object({
    type: z.literal(3),
    name: z.literal('youtube'),
    value: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal(3),
    name: z.literal('message'),
    value: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal(3),
    name: z.literal('ping'),
    value: z.enum(['everyone', 'here']),
  }),
  z.object({
    type: z.literal(8),
    name: z.literal('role'),
    value: DiscordSnowflake,
  }),
]);

const YouTubeAddOptions = z
  .array(YouTubeAddOption)
  .superRefine((options, context) => {
    const names = new Set<string>();
    for (const option of options) {
      if (names.has(option.name)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate option: ${option.name}`,
        });
      }
      names.add(option.name);
    }
    if (names.has('ping') && names.has('role')) {
      context.addIssue({
        code: 'custom',
        message: 'Choose either ping or role',
      });
    }
  })
  .transform((options, context) => {
    const youtubeOption = options.find(({ name }) => name === 'youtube');
    if (youtubeOption === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'YouTube channel is required',
      });
      return z.NEVER;
    }
    const messageOption = options.find(({ name }) => name === 'message');
    const pingOption = options.find(({ name }) => name === 'ping');
    const roleOption = options.find(({ name }) => name === 'role');
    const message =
      messageOption?.name === 'message' ? messageOption.value : undefined;
    const ping = pingOption?.name === 'ping' ? pingOption.value : undefined;
    const roleId = roleOption?.name === 'role' ? roleOption.value : undefined;
    return {
      youtube: youtubeOption.value,
      ...(message === undefined ? {} : { message }),
      ...(ping === undefined ? {} : { ping }),
      ...(roleId === undefined ? {} : { roleId }),
    };
  });

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
    options: z.array(z.never()).max(0).optional(),
  })
  .transform(({ name }) => ({ name }));

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
    options: z.tuple([
      z.union([YouTubeAddCommand, YouTubeListCommand, YouTubeRemoveCommand]),
    ]),
  })
  .transform(({ options: [command] }) => command);

/** Handles the authenticated `/youtube` application command. */
async function handleYouTubeCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const parsed = YouTubeCommand.safeParse(interaction.data);
  if (!parsed.success) return unsupportedInteractionResponse();

  const context = getCommandContext(interaction);
  if (context instanceof Response) return context;
  const command = parsed.data;

  switch (command.name) {
    case 'add': {
      const permissionError = validateYouTubeAdd(interaction);
      if (permissionError !== undefined) {
        return createEphemeralResponse(permissionError);
      }
      const ping = resolveNotificationPing(
        command.options,
        interaction,
        context.guildId,
      );
      if ('error' in ping) return createEphemeralResponse(ping.error);

      ctx.waitUntil(
        completeYouTubeAdd(env, context, command.options, ping.ping),
      );
      return createDeferredResponse();
    }
    case 'remove':
      ctx.waitUntil(completeYouTubeRemove(env, context));
      return createDeferredResponse();
    case 'list':
      return listYouTubeSubscriptions(env, context);
  }
}

export const youtubeDiscordCommand: DiscordCommandHandler = {
  name: YOUTUBE_COMMAND_NAME,
  handle: handleYouTubeCommand,
};

function validateYouTubeAdd(
  interaction: DiscordInteraction,
): string | undefined {
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
    await reportYouTubeFailure(
      context,
      'add',
      'The YouTube notification could not be added. Please try again.',
      error,
    );
  }
}

async function completeYouTubeRemove(
  env: Env,
  context: DiscordCommandContext,
): Promise<void> {
  try {
    const channelIds = await listChannelYouTubeSubscriptions(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX,
      context.channelId,
    );
    await Promise.all(
      channelIds.map((channelId) =>
        env.YOUTUBE_SUBSCRIPTIONS.getByName(channelId).removeSubscriber(
          context.channelId,
        ),
      ),
    );
    const content =
      channelIds.length === 0
        ? `No YouTube notifications were configured for <#${context.channelId}>.`
        : `Removed ${channelIds.length} YouTube notification${channelIds.length === 1 ? '' : 's'} from <#${context.channelId}>.`;
    await editInteractionResponse(
      context.applicationId,
      context.token,
      content,
    );
  } catch (error) {
    await reportYouTubeFailure(
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
    const subscriptions = await listGuildYouTubeSubscriptions(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX,
      context.guildId,
    );
    if (subscriptions.length === 0) {
      return createEphemeralResponse(
        'No YouTube notifications are configured for this server.',
      );
    }
    return createEphemeralResponse(
      createNotificationList(
        '**YouTube notifications in this server**',
        subscriptions.map((subscription) => ({
          name: subscription.youtubeChannelTitle,
          channelId: subscription.discordChannelId,
          providerId: subscription.youtubeChannelId,
        })),
        context.channelId,
      ),
    );
  } catch (error) {
    logCommandFailure('youtube', 'list', context, error);
    return createEphemeralResponse(
      'YouTube notifications could not be loaded. Please try again.',
    );
  }
}

async function reportYouTubeFailure(
  context: DiscordCommandContext,
  action: 'add' | 'remove',
  message: string,
  error: unknown,
): Promise<void> {
  logCommandFailure('youtube', action, context, error);
  try {
    await editInteractionResponse(
      context.applicationId,
      context.token,
      message,
    );
  } catch (responseError) {
    logCommandFailure('youtube', action, context, responseError);
  }
}
