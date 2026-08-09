import { ButtonStyleTypes, MessageComponentTypes } from 'discord-interactions';

import type { DiscordEmbed, DiscordMessage } from './message';
import { isDiscordSnowflake } from './snowflake';

export const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';

const MAX_EMBEDS = 10;
const MAX_EMBED_FIELDS = 25;
const MAX_LINK_BUTTONS = 5;
const MAX_EMBED_COLOR = 0xffffff;
const ISO_8601_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Identifies a Discord request that cannot be sent without changing it. */
export class DiscordRequestValidationError extends Error {}

interface DiscordAllowedMentionsPayload {
  parse: ['everyone'] | [];
  roles?: string[];
  users?: string[];
}

interface DiscordLinkButtonPayload {
  type: MessageComponentTypes.BUTTON;
  style: ButtonStyleTypes.LINK;
  label: string;
  url: string;
}

interface DiscordActionRowPayload {
  type: MessageComponentTypes.ACTION_ROW;
  components: DiscordLinkButtonPayload[];
}

interface DiscordEmbedPayload {
  author?: {
    name: string;
    icon_url?: string;
  };
  title?: string;
  url?: string;
  color?: number;
  fields?: {
    name: string;
    value: string;
    inline?: boolean;
  }[];
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

interface DiscordCreateMessagePayload {
  content: string;
  nonce?: string;
  enforce_nonce?: true;
  allowed_mentions: DiscordAllowedMentionsPayload;
  embeds?: DiscordEmbedPayload[];
  components?: DiscordActionRowPayload[];
}

/** Values required to build an authenticated Discord create-message request. */
export interface CreateDiscordMessageRequestOptions {
  /** Secret token used to authenticate the Discord bot. */
  botToken: string;
  /** Discord channel snowflake that will receive the message. */
  channelId: string;
  /** Public application URL included in the Discord API user agent. */
  applicationUrl: string;
  /** Message content and delivery options to serialize for Discord. */
  message: DiscordMessage;
}

/** Values required to edit a message previously sent by the bot. */
export interface EditDiscordMessageRequestOptions extends Omit<
  CreateDiscordMessageRequestOptions,
  'message'
> {
  /** Discord message snowflake returned by the create-message request. */
  messageId: string;
  /** Complete replacement content for the existing message. */
  message: Omit<DiscordMessage, 'nonce'>;
}

/**
 * Builds an authenticated Discord create-message request.
 *
 * Throws when an option or supported message component is invalid.
 */
export function createDiscordMessageRequest({
  botToken,
  channelId,
  applicationUrl,
  message,
}: CreateDiscordMessageRequestOptions): Request {
  requireNonEmpty(botToken, 'Discord bot token');
  requireSnowflake(channelId, 'Discord channel ID');
  requireNonEmpty(message.content, 'Discord message content');

  if (message.nonce !== undefined) {
    requireNonEmpty(message.nonce, 'Discord message nonce');
  }

  const allowedMentions: DiscordAllowedMentionsPayload = {
    parse: message.allowedMentions?.everyone === true ? ['everyone'] : [],
  };

  if (message.allowedMentions?.roleIds !== undefined) {
    for (const roleId of message.allowedMentions.roleIds) {
      requireSnowflake(roleId, 'Discord role ID');
    }

    allowedMentions.roles = message.allowedMentions.roleIds;
  }

  if (message.allowedMentions?.userIds !== undefined) {
    for (const userId of message.allowedMentions.userIds) {
      requireSnowflake(userId, 'Discord user ID');
    }

    allowedMentions.users = message.allowedMentions.userIds;
  }

  if (message.embeds !== undefined) {
    requireArrayLength(message.embeds, 'Discord message embeds', MAX_EMBEDS);
  }

  const embeds: DiscordEmbedPayload[] | undefined =
    message.embeds?.map(createEmbedPayload);

  if (message.linkButtons !== undefined) {
    requireArrayLength(
      message.linkButtons,
      'Discord message link buttons',
      MAX_LINK_BUTTONS,
    );
  }

  const linkButtons: DiscordLinkButtonPayload[] | undefined =
    message.linkButtons?.map((button, index) => {
      requireNonEmpty(button.label, `Discord link button ${index + 1} label`);
      requireHttpUrl(button.url, `Discord link button ${index + 1} URL`);

      return {
        type: MessageComponentTypes.BUTTON,
        style: ButtonStyleTypes.LINK,
        label: button.label,
        url: button.url,
      };
    });

  const applicationOrigin = requireHttpOrigin(
    applicationUrl,
    'Discord application URL',
  );

  const body: DiscordCreateMessagePayload = {
    content: message.content,
    nonce: message.nonce,
    enforce_nonce: message.nonce === undefined ? undefined : true,
    allowed_mentions: allowedMentions,
    embeds,
    components:
      linkButtons === undefined
        ? undefined
        : [
            {
              type: MessageComponentTypes.ACTION_ROW,
              components: linkButtons,
            },
          ],
  };

  return new Request(
    new URL(`channels/${channelId}/messages`, DISCORD_API_BASE_URL),
    {
      method: 'POST',
      headers: {
        authorization: `Bot ${botToken}`,
        'content-type': 'application/json',
        'user-agent': `DiscordBot (${applicationOrigin}, 0.0.0)`,
      },
      body: JSON.stringify(body),
    },
  );
}

/** Builds an authenticated Discord edit-message request. */
export function createDiscordEditMessageRequest({
  messageId,
  ...options
}: EditDiscordMessageRequestOptions): Request {
  requireSnowflake(messageId, 'Discord message ID');
  const createRequest = createDiscordMessageRequest(options);

  return new Request(
    new URL(
      `channels/${options.channelId}/messages/${messageId}`,
      DISCORD_API_BASE_URL,
    ),
    {
      method: 'PATCH',
      headers: createRequest.headers,
      body: createRequest.body,
    },
  );
}

function createEmbedPayload(
  embed: DiscordEmbed,
  index: number,
): DiscordEmbedPayload {
  const name = `Discord embed ${index + 1}`;

  if (embed.author !== undefined) {
    requireNonEmpty(embed.author.name, `${name} author name`);

    if (embed.author.iconUrl !== undefined) {
      requireHttpUrl(embed.author.iconUrl, `${name} author icon URL`);
    }
  }

  if (embed.title !== undefined) {
    requireNonEmpty(embed.title, `${name} title`);
  }

  if (embed.url !== undefined) {
    requireHttpUrl(embed.url, `${name} URL`);
  }

  if (embed.color !== undefined) {
    requireColor(embed.color, `${name} color`);
  }

  if (embed.fields !== undefined) {
    requireArrayLength(embed.fields, `${name} fields`, MAX_EMBED_FIELDS);

    for (const [fieldIndex, field] of embed.fields.entries()) {
      const fieldName = `${name} field ${fieldIndex + 1}`;
      requireNonEmpty(field.name, `${fieldName} name`);
      requireNonEmpty(field.value, `${fieldName} value`);
    }
  }

  if (embed.thumbnail !== undefined) {
    requireHttpUrl(embed.thumbnail.url, `${name} thumbnail URL`);
  }

  if (embed.image !== undefined) {
    requireHttpUrl(embed.image.url, `${name} image URL`);
  }

  if (embed.footer !== undefined) {
    requireNonEmpty(embed.footer.text, `${name} footer text`);
  }

  if (embed.timestamp !== undefined) {
    requireIsoTimestamp(embed.timestamp, `${name} timestamp`);
  }

  return {
    author:
      embed.author === undefined
        ? undefined
        : {
            name: embed.author.name,
            icon_url: embed.author.iconUrl,
          },
    title: embed.title,
    url: embed.url,
    color: embed.color,
    fields: embed.fields?.map((field) => ({
      name: field.name,
      value: field.value,
      inline: field.inline,
    })),
    thumbnail:
      embed.thumbnail === undefined ? undefined : { url: embed.thumbnail.url },
    image: embed.image === undefined ? undefined : { url: embed.image.url },
    footer:
      embed.footer === undefined ? undefined : { text: embed.footer.text },
    timestamp: embed.timestamp,
  };
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim() === '') {
    throw new DiscordRequestValidationError(`${name} cannot be empty`);
  }
}

function requireSnowflake(value: string, name: string): void {
  if (!isDiscordSnowflake(value)) {
    throw new DiscordRequestValidationError(
      `${name} must be a Discord snowflake`,
    );
  }
}

function requireArrayLength(
  values: readonly unknown[],
  name: string,
  maximum: number,
): void {
  if (values.length === 0 || values.length > maximum) {
    throw new DiscordRequestValidationError(
      `${name} must contain between 1 and ${maximum} items`,
    );
  }
}

function requireHttpUrl(value: string, name: string): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new DiscordRequestValidationError(`${name} must be an HTTP(S) URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DiscordRequestValidationError(`${name} must be an HTTP(S) URL`);
  }
}

function requireHttpOrigin(value: string, name: string): string {
  requireHttpUrl(value, name);
  return new URL(value).origin;
}

function requireColor(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_EMBED_COLOR) {
    throw new DiscordRequestValidationError(
      `${name} must be an integer between 0 and ${MAX_EMBED_COLOR}`,
    );
  }
}

function requireIsoTimestamp(value: string, name: string): void {
  if (!ISO_8601_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new DiscordRequestValidationError(
      `${name} must be a valid ISO 8601 timestamp`,
    );
  }
}
