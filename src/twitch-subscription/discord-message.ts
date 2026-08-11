import type {
  broadcasters,
  streams,
  twitchSubscribers,
} from '../db/twitch-subscription/schema';
import {
  createDiscordMention,
  createDiscordMessage,
  createDiscordNonce,
} from '../discord/message';
import type {
  DiscordCreateMessageDelivery,
  DiscordEditMessageDelivery,
} from '../queue/discord-message';
import { DISCORD_RECEIPT_TWITCH_STREAM } from '../queue/discord-message';

const TWITCH_COLOR = 0x9146ff;
const DEFAULT_LIVE_MESSAGE = 'is live now!';
const DEFAULT_OFFLINE_MESSAGE = 'was live.';

type Broadcaster = typeof broadcasters.$inferSelect;
type Stream = typeof streams.$inferSelect;
type Subscriber = typeof twitchSubscribers.$inferSelect;

/** Creates an initial Discord notification for a Twitch stream. */
export async function createTwitchLiveDelivery(
  broadcaster: Broadcaster,
  stream: Stream,
  subscriber: Subscriber,
): Promise<DiscordCreateMessageDelivery> {
  const channelUrl = twitchChannelUrl(broadcaster.login);
  const mention = createDiscordMention(subscriber.ping);
  const content = [
    mention.content,
    subscriber.message ?? `${broadcaster.displayName} ${DEFAULT_LIVE_MESSAGE}`,
    channelUrl,
  ]
    .filter((part) => part !== undefined)
    .join(' ');
  const message = createDiscordMessage({
    content,
    nonce: await createDiscordNonce(stream.id, subscriber.channelId),
    allowedMentions: mention.allowedMentions,
    embeds: [
      {
        author: broadcasterAuthor(broadcaster),
        title: stream.title,
        url: channelUrl,
        color: TWITCH_COLOR,
        fields: [
          { name: 'Game', value: stream.gameName, inline: true },
          {
            name: 'Viewers',
            value: String(stream.viewerCount),
            inline: true,
          },
        ],
        ...(stream.gameBoxArtUrl === null
          ? {}
          : {
              thumbnail: {
                url: resizeTwitchImage(stream.gameBoxArtUrl, 144, 192),
              },
            }),
        image: {
          url: cacheBustPreview(stream.previewImageUrl, stream.startedAt),
        },
        footer: { text: 'Started streaming' },
        timestamp: stream.startedAt.toISOString(),
      },
    ],
    linkButtons: [{ label: 'Watch Stream', url: channelUrl }],
  });

  return {
    operation: 'create',
    guildId: subscriber.guildId,
    channelId: subscriber.channelId,
    receiptTarget: {
      type: DISCORD_RECEIPT_TWITCH_STREAM,
      broadcasterId: broadcaster.id,
      streamId: stream.id,
    },
    message,
  };
}

/** Creates a replacement Discord message for an ended Twitch stream. */
export function createTwitchOfflineDelivery(
  broadcaster: Broadcaster,
  stream: Stream,
  subscriber: Subscriber,
  messageId: string,
): DiscordEditMessageDelivery {
  if (stream.endedAt === null) {
    throw new Error('Cannot create an offline message for a live stream');
  }
  const channelUrl = twitchChannelUrl(broadcaster.login);
  const watchUrl = stream.vodUrl ?? channelUrl;
  const message = createDiscordMessage({
    content:
      subscriber.offline ??
      `${broadcaster.displayName} ${DEFAULT_OFFLINE_MESSAGE}`,
    embeds: [
      {
        author: broadcasterAuthor(broadcaster),
        title: stream.title,
        url: watchUrl,
        color: TWITCH_COLOR,
        fields: [
          { name: 'Game', value: stream.gameName, inline: true },
          {
            name: 'Duration',
            value: formatDuration(stream.endedAt, stream.startedAt),
            inline: true,
          },
        ],
        ...(broadcaster.offlineImageUrl === ''
          ? {}
          : { image: { url: broadcaster.offlineImageUrl } }),
        footer: { text: 'Last online' },
        timestamp: stream.endedAt.toISOString(),
      },
    ],
    linkButtons: [
      {
        label: stream.vodUrl === null ? 'Watch Channel' : 'Watch VOD',
        url: watchUrl,
      },
    ],
  });

  return {
    operation: 'edit',
    guildId: subscriber.guildId,
    channelId: subscriber.channelId,
    messageId,
    message,
  };
}

function broadcasterAuthor(broadcaster: Broadcaster) {
  return {
    name: broadcaster.displayName,
    ...(broadcaster.profileImageUrl === ''
      ? {}
      : { iconUrl: broadcaster.profileImageUrl }),
  };
}

function twitchChannelUrl(login: string): string {
  return `https://twitch.tv/${login}`;
}

function resizeTwitchImage(url: string, width: number, height: number): string {
  return url
    .replaceAll('{width}', String(width))
    .replaceAll('{height}', String(height));
}

function cacheBustPreview(url: string, startedAt: Date): string {
  const resized = resizeTwitchImage(url, 1280, 720);
  const preview = new URL(resized);
  preview.searchParams.set('t', String(startedAt.getTime()));
  return preview.toString();
}

function formatDuration(endedAt: Date, startedAt: Date): string {
  let seconds = Math.max(
    0,
    Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
  );
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [
    hours === 0 ? undefined : `${hours}h`,
    minutes === 0 ? undefined : `${minutes}m`,
    `${seconds}s`,
  ]
    .filter((part) => part !== undefined)
    .join(' ');
}
