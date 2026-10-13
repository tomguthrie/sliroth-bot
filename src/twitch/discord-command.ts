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
import {
  canPostInChannel,
  EMBED_LINKS_PERMISSION,
  getCommandContext,
  hasDiscordPermission,
  isNotificationChannel,
  resolveNotificationPing,
} from '../discord/permission';
import type { DiscordCommandContext } from '../discord/permission';
import { DiscordSnowflake } from '../discord/snowflake';
import { resolveTwitchChannel } from './channel';
import twitchCommand from './discord-command.json';
import { twitchSubscriptionLookup } from './lookup';

const TWITCH_COMMAND_NAME = twitchCommand.name;

const TwitchAddOptions = CommandOptions.pipe(
  z
    .strictObject({
      twitch: z.string().trim().min(1),
      message: z.string().trim().min(1).optional(),
      offline: z.string().trim().min(1).optional(),
      ping: z.enum(['everyone', 'here']).optional(),
      role: DiscordSnowflake.optional(),
    })
    .refine(({ ping, role }) => ping === undefined || role === undefined, {
      message: 'Choose either ping or role',
    }),
);

const TwitchAddCommand = z
  .object({
    type: z.literal(1),
    name: z.literal('add'),
    options: TwitchAddOptions,
  })
  .transform(({ name, options }) => ({ name, options }));

const TwitchListCommand = z
  .object({
    type: z.literal(1),
    name: z.literal('list'),
    options: z.array(z.never()).max(0).optional(),
  })
  .transform(({ name }) => ({ name }));

const TwitchRemoveCommand = z
  .object({
    type: z.literal(1),
    name: z.literal('remove'),
    options: z.array(z.never()).max(0).optional(),
  })
  .transform(({ name }) => ({ name }));

const TwitchCommand = z
  .object({
    name: z.literal(TWITCH_COMMAND_NAME),
    options: z.tuple([z.union([TwitchAddCommand, TwitchListCommand, TwitchRemoveCommand])]),
  })
  .transform(({ options: [command] }) => command);

/** Handles the authenticated `/twitch` application command. */
async function handleTwitchCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const parsed = TwitchCommand.safeParse(interaction.data);
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
      const permissionError = validateTwitchAdd(interaction);
      if (permissionError !== undefined) {
        return createEphemeralResponse(permissionError);
      }
      const ping = resolveNotificationPing(command.options, interaction, context.guildId);
      if ('error' in ping) {
        return createEphemeralResponse(ping.error);
      }

      ctx.waitUntil(completeTwitchAdd(env, context, command.options, ping.ping));
      return createDeferredResponse();
    }
    case 'remove':
      ctx.waitUntil(completeTwitchRemove(env, context));
      return createDeferredResponse();
    case 'list':
      return listTwitchSubscriptions(env, context);
  }
}

export const twitchDiscordCommand: DiscordCommandHandler = {
  name: TWITCH_COMMAND_NAME,
  handle: handleTwitchCommand,
};

function validateTwitchAdd(interaction: DiscordInteraction): string | undefined {
  if (!isNotificationChannel(interaction)) {
    return 'Twitch notifications can only be added in a text or announcement channel.';
  }
  if (!canPostInChannel(interaction.app_permissions)) {
    return 'I need View Channel and Send Messages permissions in this channel.';
  }
  if (!hasDiscordPermission(interaction.app_permissions, EMBED_LINKS_PERMISSION)) {
    return 'I need Embed Links permission in this channel.';
  }
  return undefined;
}

async function completeTwitchAdd(
  env: Env,
  context: DiscordCommandContext,
  options: z.infer<typeof TwitchAddOptions>,
  ping: string | undefined,
): Promise<void> {
  try {
    const broadcaster = await resolveTwitchChannel(options.twitch, env);
    if (broadcaster === undefined) {
      await editInteractionResponse(
        context.applicationId,
        context.token,
        'That Twitch channel could not be resolved.',
      );
      return;
    }
    await env.TWITCH_SUBSCRIPTIONS.getByName(broadcaster.id).addSubscriber(broadcaster, {
      guildId: context.guildId,
      channelId: context.channelId,
      message: options.message,
      offline: options.offline,
      ping,
    });
    await editInteractionResponse(
      context.applicationId,
      context.token,
      `Streams from **${escapeDiscordMarkdown(broadcaster.displayName)}** will be posted in <#${context.channelId}>${describeDiscordMention(ping)}.`,
    );
  } catch (error) {
    await reportCommandFailure(
      'twitch',
      context,
      'add',
      'The Twitch notification could not be added. Please try again.',
      error,
    );
  }
}

async function completeTwitchRemove(env: Env, context: DiscordCommandContext): Promise<void> {
  try {
    const broadcasterIds = await twitchSubscriptionLookup.listChannel(
      env.TWITCH_SUBSCRIPTIONS_INDEX,
      context.channelId,
    );
    await Promise.all(
      broadcasterIds.map((broadcasterId) =>
        env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId).removeSubscriber(context.channelId),
      ),
    );
    const content =
      broadcasterIds.length === 0
        ? `No Twitch notifications were configured for <#${context.channelId}>.`
        : `Removed ${broadcasterIds.length} Twitch notification${broadcasterIds.length === 1 ? '' : 's'} from <#${context.channelId}>.`;
    await editInteractionResponse(context.applicationId, context.token, content);
  } catch (error) {
    await reportCommandFailure(
      'twitch',
      context,
      'remove',
      'The Twitch notifications could not be removed. Please try again.',
      error,
    );
  }
}

async function listTwitchSubscriptions(
  env: Env,
  context: DiscordCommandContext,
): Promise<Response> {
  try {
    const subscriptions = await twitchSubscriptionLookup.listGuild(
      env.TWITCH_SUBSCRIPTIONS_INDEX,
      context.guildId,
    );
    if (subscriptions.length === 0) {
      return createEphemeralResponse('No Twitch notifications are configured for this server.');
    }
    return createEphemeralResponse(
      createNotificationList(
        '**Twitch notifications in this server**',
        subscriptions.map(({ channelId, providerId, metadata }) => ({
          name: metadata.displayName,
          channelId,
          providerId,
        })),
        context.channelId,
      ),
    );
  } catch (error) {
    logCommandFailure('twitch', 'list', context, error);
    return createEphemeralResponse('Twitch notifications could not be loaded. Please try again.');
  }
}
