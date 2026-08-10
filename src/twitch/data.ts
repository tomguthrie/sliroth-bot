import * as z from 'zod';

const TWITCH_LOGIN = /^[A-Za-z0-9_]{1,25}$/;
const RESERVED_TWITCH_PATHS = new Set([
  'directory',
  'downloads',
  'jobs',
  'p',
  'search',
  'settings',
  'subscriptions',
  'turbo',
  'videos',
  'wallet',
]);

/** Identifies a Twitch broadcaster. */
export const TwitchBroadcasterId = z
  .string()
  .regex(/^\d+$/)
  .brand<'TwitchBroadcasterId'>();

export type TwitchBroadcasterId = z.infer<typeof TwitchBroadcasterId>;

/** Identifies a Twitch channel by its normalized login. */
export const TwitchLogin = z
  .string()
  .transform((value) => (value.startsWith('@') ? value.slice(1) : value))
  .refine(
    (value) =>
      TWITCH_LOGIN.test(value) &&
      !RESERVED_TWITCH_PATHS.has(value.toLowerCase()),
  )
  .brand<'TwitchLogin'>();

export type TwitchLogin = z.infer<typeof TwitchLogin>;

/** Identifies a Twitch stream. */
export const TwitchStreamId = z.string().min(1).brand<'TwitchStreamId'>();

export type TwitchStreamId = z.infer<typeof TwitchStreamId>;

/** Identifies a Twitch category or game. */
export const TwitchGameId = z.string().min(1).brand<'TwitchGameId'>();

export type TwitchGameId = z.infer<typeof TwitchGameId>;

/** Identifies a Twitch video. */
export const TwitchVideoId = z.string().min(1).brand<'TwitchVideoId'>();

export type TwitchVideoId = z.infer<typeof TwitchVideoId>;

/** Identifies a Twitch EventSub subscription. */
export const TwitchEventSubSubscriptionId = z
  .string()
  .min(1)
  .brand<'TwitchEventSubSubscriptionId'>();

export type TwitchEventSubSubscriptionId = z.infer<
  typeof TwitchEventSubSubscriptionId
>;

/** A Twitch RFC 3339 timestamp represented as an ISO datetime string. */
export const TwitchTimestamp = z.iso
  .datetime({ offset: true })
  .brand<'TwitchTimestamp'>();

export type TwitchTimestamp = z.infer<typeof TwitchTimestamp>;
