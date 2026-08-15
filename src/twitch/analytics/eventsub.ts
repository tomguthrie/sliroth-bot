import {
  TWITCH_EVENT_CHANNEL_CHAT_MESSAGE,
  TWITCH_EVENT_CHANNEL_CHEER,
  TWITCH_EVENT_CHANNEL_FOLLOW,
  TWITCH_EVENT_CHANNEL_POINTS_REDEMPTION,
  TWITCH_EVENT_CHANNEL_RAID,
  TWITCH_EVENT_CHANNEL_SUBSCRIBE,
  TWITCH_EVENT_CHANNEL_SUBSCRIPTION_GIFT,
} from '../eventsub';

export interface AnalyticsEventSubSubscription {
  readonly key: string;
  readonly type: string;
  readonly version: string;
  condition(broadcasterId: string): Record<string, string>;
}

const broadcasterCondition = (broadcasterId: string) => ({
  broadcaster_user_id: broadcasterId,
});

/** EventSub notifications used to build Twitch stream analytics. */
export const TWITCH_ANALYTICS_EVENTSUB_SUBSCRIPTIONS: readonly AnalyticsEventSubSubscription[] =
  [
    {
      key: 'analytics:follow',
      type: TWITCH_EVENT_CHANNEL_FOLLOW,
      version: '2',
      condition: (broadcasterId) => ({
        broadcaster_user_id: broadcasterId,
        moderator_user_id: broadcasterId,
      }),
    },
    {
      key: 'analytics:subscribe',
      type: TWITCH_EVENT_CHANNEL_SUBSCRIBE,
      version: '1',
      condition: broadcasterCondition,
    },
    {
      key: 'analytics:subscription-gift',
      type: TWITCH_EVENT_CHANNEL_SUBSCRIPTION_GIFT,
      version: '1',
      condition: broadcasterCondition,
    },
    {
      key: 'analytics:cheer',
      type: TWITCH_EVENT_CHANNEL_CHEER,
      version: '1',
      condition: broadcasterCondition,
    },
    {
      key: 'analytics:points-redemption',
      type: TWITCH_EVENT_CHANNEL_POINTS_REDEMPTION,
      version: '1',
      condition: broadcasterCondition,
    },
    {
      key: 'analytics:chat-message',
      type: TWITCH_EVENT_CHANNEL_CHAT_MESSAGE,
      version: '1',
      condition: (broadcasterId) => ({
        broadcaster_user_id: broadcasterId,
        user_id: broadcasterId,
      }),
    },
    {
      key: 'analytics:raid-in',
      type: TWITCH_EVENT_CHANNEL_RAID,
      version: '1',
      condition: (broadcasterId) => ({
        to_broadcaster_user_id: broadcasterId,
      }),
    },
    {
      key: 'analytics:raid-out',
      type: TWITCH_EVENT_CHANNEL_RAID,
      version: '1',
      condition: (broadcasterId) => ({
        from_broadcaster_user_id: broadcasterId,
      }),
    },
  ];

export const TWITCH_ANALYTICS_SCOPES = [
  'bits:read',
  'channel:bot',
  'channel:read:redemptions',
  'channel:read:subscriptions',
  'moderator:read:followers',
  'user:bot',
  'user:read:chat',
] as const;
