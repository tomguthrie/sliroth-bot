import { ButtonStyleTypes, MessageComponentTypes } from 'discord-interactions';
import * as z from 'zod';

import type { DiscordMessage } from './message';
import type { DiscordSnowflake } from './snowflake';

export const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';

const HttpOrigin = z
  .url({ protocol: /^https?$/ })
  .transform((value) => new URL(value).origin);

type DiscordEmbed = NonNullable<DiscordMessage['embeds']>[number];

interface DiscordAllowedMentionsPayload {
  parse: ['everyone'] | [];
  roles?: DiscordSnowflake[];
  users?: DiscordSnowflake[];
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
  channelId: DiscordSnowflake;
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
  messageId: DiscordSnowflake;
  /** Complete replacement content for the existing message. */
  message: DiscordMessage;
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
  const allowedMentions: DiscordAllowedMentionsPayload = {
    parse: message.allowedMentions?.everyone === true ? ['everyone'] : [],
  };

  if (message.allowedMentions?.roleIds !== undefined) {
    allowedMentions.roles = message.allowedMentions.roleIds;
  }

  if (message.allowedMentions?.userIds !== undefined) {
    allowedMentions.users = message.allowedMentions.userIds;
  }

  const embeds: DiscordEmbedPayload[] | undefined =
    message.embeds?.map(createEmbedPayload);

  const linkButtons: DiscordLinkButtonPayload[] | undefined =
    message.linkButtons?.map((button) => ({
      type: MessageComponentTypes.BUTTON,
      style: ButtonStyleTypes.LINK,
      label: button.label,
      url: button.url,
    }));

  const applicationOrigin = HttpOrigin.parse(applicationUrl);

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

function createEmbedPayload(embed: DiscordEmbed): DiscordEmbedPayload {
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
