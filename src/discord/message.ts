/**
 * Controls which mentions in a Discord message may notify users.
 *
 * @see https://docs.discord.com/developers/resources/message#allowed-mentions-object
 */
export interface DiscordAllowedMentions {
  roleIds?: string[];
  userIds?: string[];
  everyone?: boolean;
}

/**
 * Sets the author displayed at the top of an embed.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-author-structure
 */
export interface DiscordEmbedAuthor {
  name: string;
  iconUrl?: string;
}

/**
 * Adds a named piece of information to an embed.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-field-structure
 */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * Supplies an image for an embed.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-image-structure
 */
export interface DiscordEmbedMedia {
  url: string;
}

/**
 * Adds text to the bottom of an embed.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-footer-structure
 */
export interface DiscordEmbedFooter {
  text: string;
}

/**
 * Describes a richly formatted section displayed beneath a message.
 *
 * @see https://docs.discord.com/developers/resources/message#embed-object
 */
export interface DiscordEmbed {
  author?: DiscordEmbedAuthor;
  title?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  thumbnail?: DiscordEmbedMedia;
  image?: DiscordEmbedMedia;
  footer?: DiscordEmbedFooter;
  timestamp?: string;
}

/**
 * Describes a button that opens an external URL without sending an interaction
 * back to the application.
 *
 * @see https://docs.discord.com/developers/components/reference#button
 */
export interface DiscordLinkButton {
  label: string;
  url: string;
}

/**
 * Describes the content and delivery options for a Discord message.
 *
 * @see https://docs.discord.com/developers/resources/message#create-message
 */
export interface DiscordMessage {
  content: string;
  /**
   * A short-lived idempotency key. Reusing it causes Discord to return the
   * existing message instead of creating a duplicate.
   */
  nonce?: string;
  /**
   * The mentions allowed to notify users. When omitted, mention syntax in the
   * content will not notify anyone.
   */
  allowedMentions?: DiscordAllowedMentions;
  /** Richly formatted sections displayed beneath the message content. */
  embeds?: DiscordEmbed[];
  /** URL buttons displayed beneath the message and its embeds. */
  linkButtons?: DiscordLinkButton[];
}
