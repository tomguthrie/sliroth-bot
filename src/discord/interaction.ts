import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';

import {
  cacheYouTubeChannelTitle,
  getCachedYouTubeChannelTitles,
  type GuildYouTubeSubscription,
  listGuildYouTubeSubscriptions,
} from '../youtube-subscription/index';
import { fetchYouTubeChannelTitle } from '../youtube/channel';
import youtubeCommand from './youtube-command.json';

const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;
const MANAGE_GUILD_PERMISSION = 1n << 5n;
const ADMINISTRATOR_PERMISSION = 1n << 3n;
const YOUTUBE_SUBCOMMAND = youtubeCommand.options[0];

/** Authenticates and handles Discord interaction webhooks. */
export async function handleDiscordInteraction(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());

  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (
    signature === null ||
    timestamp === null ||
    !(await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))
  ) {
    return new Response('Invalid request signature', { status: 401 });
  }

  const interaction = parseJson(body);
  if (!isRecord(interaction) || typeof interaction.type !== 'number') {
    return new Response('Bad Request', { status: 400 });
  }

  if (interaction.type === Number(InteractionType.PING)) {
    return jsonResponse({ type: InteractionResponseType.PONG });
  }

  if (
    interaction.type !== Number(InteractionType.APPLICATION_COMMAND) ||
    !isYouTubeListCommand(interaction.data)
  ) {
    return ephemeralResponse('This interaction is not supported.');
  }

  const guildId = getSnowflake(interaction.guild_id);
  const channelId = getSnowflake(interaction.channel_id);
  if (guildId === undefined || channelId === undefined) {
    return ephemeralResponse('This command can only be used in a server.');
  }

  if (!hasManageGuildPermission(interaction.member)) {
    return ephemeralResponse(
      'You need the Manage Server permission to use this command.',
    );
  }

  try {
    const subscriptions = await listGuildYouTubeSubscriptions(
      env.YOUTUBE_SUBSCRIPTIONS_INDEX,
      guildId,
    );
    if (subscriptions.length === 0) {
      return ephemeralResponse(
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

    return ephemeralResponse(
      createYouTubeListContent(subscriptions, titles, channelId),
    );
  } catch (error) {
    logInteractionFailure(error);
    return ephemeralResponse(
      'YouTube notifications could not be loaded. Please try again.',
    );
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

function escapeDiscordMarkdown(value: string): string {
  return value.replaceAll(/([\\`*_{}[\]()<>#+\-.!|~])/g, '\\$1');
}

function isYouTubeListCommand(value: unknown): boolean {
  if (!isRecord(value) || value.name !== youtubeCommand.name) {
    return false;
  }
  if (!Array.isArray(value.options) || value.options.length !== 1) {
    return false;
  }

  const option: unknown = value.options[0];
  return (
    isRecord(option) &&
    option.type === YOUTUBE_SUBCOMMAND.type &&
    option.name === YOUTUBE_SUBCOMMAND.name
  );
}

function hasManageGuildPermission(member: unknown): boolean {
  if (!isRecord(member) || typeof member.permissions !== 'string') {
    return false;
  }

  try {
    const permissions = BigInt(member.permissions);
    return (
      (permissions & MANAGE_GUILD_PERMISSION) !== 0n ||
      (permissions & ADMINISTRATOR_PERMISSION) !== 0n
    );
  } catch {
    return false;
  }
}

function getSnowflake(value: unknown): string | undefined {
  return typeof value === 'string' && DISCORD_SNOWFLAKE.test(value)
    ? value
    : undefined;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}

function ephemeralResponse(content: string): Response {
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: InteractionResponseFlags.EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
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
