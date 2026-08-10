import * as z from 'zod';

/** Identifies a YouTube channel. */
export const YouTubeChannelId = z
  .string()
  .regex(/^UC[A-Za-z0-9_-]{22}$/)
  .brand<'YouTubeChannelId'>();

export type YouTubeChannelId = z.infer<typeof YouTubeChannelId>;

/** Identifies a YouTube channel by its normalized handle. */
export const YouTubeHandle = z
  .string()
  .transform((value) => (value.startsWith('@') ? value.slice(1) : value))
  .refine(
    (value) =>
      value !== '' &&
      !/[\s/\\?#]/u.test(value) &&
      !YouTubeChannelId.safeParse(value).success,
  )
  .brand<'YouTubeHandle'>();

export type YouTubeHandle = z.infer<typeof YouTubeHandle>;
