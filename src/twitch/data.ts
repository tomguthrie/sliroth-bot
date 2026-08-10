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
