import * as z from 'zod';

import {
  TwitchBroadcasterId,
  TwitchGameId,
  TwitchLogin,
  TwitchStreamId,
  TwitchTimestamp,
} from './data';

export const TWITCH_EVENT_CHANNEL_UPDATE = 'channel.update';
export const TWITCH_EVENT_STREAM_ONLINE = 'stream.online';
export const TWITCH_EVENT_STREAM_OFFLINE = 'stream.offline';

export const TwitchChannelUpdateEvent = z.object({
  broadcaster_user_id: TwitchBroadcasterId,
  broadcaster_user_login: TwitchLogin,
  broadcaster_user_name: z.string().trim().min(1),
  title: z.string(),
  language: z.string(),
  category_id: z.union([z.literal(''), TwitchGameId]),
  category_name: z.string(),
  content_classification_labels: z.array(z.string()),
});

export type TwitchChannelUpdateEvent = z.infer<typeof TwitchChannelUpdateEvent>;

export const TwitchStreamOnlineEvent = z.object({
  id: TwitchStreamId,
  broadcaster_user_id: TwitchBroadcasterId,
  broadcaster_user_login: TwitchLogin,
  broadcaster_user_name: z.string().trim().min(1),
  type: z.string().min(1),
  started_at: TwitchTimestamp,
});

export type TwitchStreamOnlineEvent = z.infer<typeof TwitchStreamOnlineEvent>;

export const TwitchStreamOfflineEvent = z.object({
  id: TwitchStreamId,
  broadcaster_user_id: TwitchBroadcasterId,
  broadcaster_user_login: TwitchLogin,
  broadcaster_user_name: z.string().trim().min(1),
});

export type TwitchStreamOfflineEvent = z.infer<typeof TwitchStreamOfflineEvent>;
