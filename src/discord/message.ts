import * as z from 'zod';

import { DiscordSnowflake } from './snowflake';

const MAX_DISCORD_NONCE_LENGTH = 25;
const MAX_EMBEDS = 10;
const MAX_EMBED_FIELDS = 25;
const MAX_LINK_BUTTONS = 5;
const MAX_EMBED_COLOR = 0xffffff;
const NonBlankString = z.string().refine((value) => value.trim() !== '');
const HttpUrl = z.url({ protocol: /^https?$/ });

/** Identifies a mention that a notification may deliberately enable. */
export const DiscordMentionTarget = z.union([
  z.literal('everyone'),
  z.literal('here'),
  DiscordSnowflake,
]);

export type DiscordMentionTarget = z.infer<typeof DiscordMentionTarget>;

/**
 * Controls which mentions in a Discord message may notify users.
 *
 * @see https://docs.discord.com/developers/resources/message#allowed-mentions-object
 */
const DiscordAllowedMentions = z.object({
  roleIds: z.array(DiscordSnowflake).optional(),
  userIds: z.array(DiscordSnowflake).optional(),
  everyone: z.boolean().optional(),
});

/**
 * Sets the author displayed at the top of an embed.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-author-structure
 */
const DiscordEmbedAuthor = z.object({
  name: NonBlankString,
  iconUrl: HttpUrl.optional(),
});

/**
 * Adds a named piece of information to an embed.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-field-structure
 */
const DiscordEmbedField = z.object({
  name: NonBlankString,
  value: NonBlankString,
  inline: z.boolean().optional(),
});

/**
 * Supplies an image for an embed.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-image-structure
 */
const DiscordEmbedMedia = z.object({ url: HttpUrl });

/**
 * Adds text to the bottom of an embed.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-footer-structure
 */
const DiscordEmbedFooter = z.object({ text: NonBlankString });

/**
 * Describes a richly formatted section displayed beneath a message.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-object
 */
const DiscordEmbed = z.object({
  author: DiscordEmbedAuthor.optional(),
  title: NonBlankString.optional(),
  url: HttpUrl.optional(),
  color: z.int().min(0).max(MAX_EMBED_COLOR).optional(),
  fields: z.array(DiscordEmbedField).min(1).max(MAX_EMBED_FIELDS).optional(),
  thumbnail: DiscordEmbedMedia.optional(),
  image: DiscordEmbedMedia.optional(),
  footer: DiscordEmbedFooter.optional(),
  timestamp: z.iso.datetime({ offset: true }).optional(),
});

/**
 * Describes a button that opens an external URL without sending an interaction
 * back to the application.
 *
 * @see https://docs.discord.com/developers/components/reference#button
 */
const DiscordLinkButton = z.object({
  label: NonBlankString,
  url: HttpUrl,
});

/**
 * Describes the content and delivery options for a Discord message.
 *
 * @see https://docs.discord.com/developers/resources/message#create-message
 */
export const DiscordMessage = z
  .object({
    content: NonBlankString,
    /**
     * A short-lived idempotency key. Reusing it causes Discord to return the
     * existing message instead of creating a duplicate.
     */
    nonce: NonBlankString.max(MAX_DISCORD_NONCE_LENGTH).optional(),
    /**
     * The mentions allowed to notify users. When omitted, mention syntax in the
     * content will not notify anyone.
     */
    allowedMentions: DiscordAllowedMentions.optional(),
    /** Richly formatted sections displayed beneath the message content. */
    embeds: z.array(DiscordEmbed).min(1).max(MAX_EMBEDS).optional(),
    /** URL buttons displayed beneath the message and its embeds. */
    linkButtons: z
      .array(DiscordLinkButton)
      .min(1)
      .max(MAX_LINK_BUTTONS)
      .optional(),
  })
  .brand<'DiscordMessage'>();

export type DiscordMessage = z.infer<typeof DiscordMessage>;
export type DiscordMessageInput = z.input<typeof DiscordMessage>;
type DiscordAllowedMentions = z.infer<typeof DiscordAllowedMentions>;

/** Validates a Discord message before it reaches delivery code. */
export function createDiscordMessage(
  message: DiscordMessageInput,
): DiscordMessage {
  return DiscordMessage.parse(message);
}

/** Derives notification content and its matching Discord mention allowlist. */
export function createDiscordMention(ping: DiscordMentionTarget | null): {
  content?: string;
  allowedMentions?: DiscordAllowedMentions;
} {
  if (ping === null) {
    return {};
  }

  if (ping === 'everyone' || ping === 'here') {
    return {
      content: `@${ping}`,
      allowedMentions: { everyone: true },
    };
  }

  return {
    content: `<@&${ping}>`,
    allowedMentions: { roleIds: [ping] },
  };
}

/** Describes the mention in a notification configuration summary. */
export function describeDiscordMention(
  ping: DiscordMentionTarget | undefined,
): string {
  if (ping === undefined) {
    return '';
  }
  if (ping === 'everyone' || ping === 'here') {
    return ` and mention @${ping}`;
  }
  return ` and mention <@&${ping}>`;
}

/** Derives Discord idempotency nonces for notification deliveries. */
export async function createDiscordNonce(
  sourceId: string,
  channelId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${sourceId}:${channelId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .slice(0, MAX_DISCORD_NONCE_LENGTH);
}
