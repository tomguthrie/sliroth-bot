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

/** Identifies a YouTube video. */
export const YouTubeVideoId = z.string().min(1).brand<'YouTubeVideoId'>();

export type YouTubeVideoId = z.infer<typeof YouTubeVideoId>;

/** A YouTube RFC 3339 timestamp represented as an ISO datetime string. */
export const YouTubeTimestamp = z.iso
  .datetime({ offset: true })
  .brand<'YouTubeTimestamp'>();

export type YouTubeTimestamp = z.infer<typeof YouTubeTimestamp>;

/** Secret material used to authenticate YouTube WebSub notifications. */
export const YouTubeWebSubSecret = z
  .string()
  .min(1)
  .brand<'YouTubeWebSubSecret'>();

export type YouTubeWebSubSecret = z.infer<typeof YouTubeWebSubSecret>;
