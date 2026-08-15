import { ButtonStyleTypes, MessageComponentTypes } from 'discord-interactions';
import * as z from 'zod';

import type { DiscordMessage } from './message';
import { DiscordSnowflake } from './snowflake';

export const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';

interface DiscordAllowedMentionsPayload {
  parse: ['everyone'] | [];
  roles?: string[];
}

interface DiscordEmbedPayload {
  author?: { name: string; icon_url?: string };
  title?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

interface DiscordMessagePayload {
  content: string;
  nonce?: string;
  enforce_nonce?: true;
  allowed_mentions: DiscordAllowedMentionsPayload;
  embeds?: DiscordEmbedPayload[];
  components?: {
    type: MessageComponentTypes.ACTION_ROW;
    components: {
      type: MessageComponentTypes.BUTTON;
      style: ButtonStyleTypes.LINK;
      label: string;
      url: string;
    }[];
  }[];
}

/** Options common to Discord message create and edit requests. */
export interface SendDiscordMessageOptions {
  botToken: string;
  channelId: string;
  applicationUrl: string;
  message: DiscordMessage;
}

/** Options for replacing a previously created Discord message. */
export interface EditDiscordMessageOptions extends SendDiscordMessageOptions {
  messageId: string;
}

/** Describes a non-successful response returned by Discord's API. */
export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Discord rejected the message with HTTP ${status}: ${detail}`);
  }
}

const DiscordMessageReceipt = z
  .object({
    id: DiscordSnowflake,
    channel_id: DiscordSnowflake,
  })
  .transform(({ id: messageId, channel_id: channelId }) => ({
    messageId,
    channelId,
  }));

export type DiscordMessageReceipt = z.infer<typeof DiscordMessageReceipt>;

/** Sends a message to Discord and returns its delivery receipt. */
export async function sendDiscordMessage(
  options: SendDiscordMessageOptions,
): Promise<DiscordMessageReceipt> {
  return executeDiscordMessageRequest(createDiscordMessageRequest(options));
}

/** Edits an existing Discord message and returns its delivery receipt. */
export async function editDiscordMessage(
  options: EditDiscordMessageOptions,
): Promise<DiscordMessageReceipt> {
  DiscordSnowflake.parse(options.messageId);
  return executeDiscordMessageRequest(
    createDiscordMessageRequest(options, options.messageId),
  );
}

function createDiscordMessageRequest(
  options: SendDiscordMessageOptions,
  messageId?: string,
): Request {
  const channelId = DiscordSnowflake.parse(options.channelId);
  const applicationUrl = new URL(options.applicationUrl);
  if (
    applicationUrl.protocol !== 'http:' &&
    applicationUrl.protocol !== 'https:'
  ) {
    throw new Error('Discord application URL must use HTTP or HTTPS');
  }

  const path =
    messageId === undefined
      ? `channels/${channelId}/messages`
      : `channels/${channelId}/messages/${messageId}`;

  return new Request(new URL(path, DISCORD_API_BASE_URL), {
    method: messageId === undefined ? 'POST' : 'PATCH',
    headers: {
      authorization: `Bot ${options.botToken}`,
      'content-type': 'application/json',
      'user-agent': `DiscordBot (${applicationUrl.origin}, 0.0.0)`,
    },
    body: JSON.stringify(createMessagePayload(options.message)),
  });
}

function createMessagePayload(message: DiscordMessage): DiscordMessagePayload {
  const allowedMentions: DiscordAllowedMentionsPayload = {
    parse: message.allowedMentions?.everyone === true ? ['everyone'] : [],
  };
  if (message.allowedMentions?.roleIds !== undefined) {
    allowedMentions.roles = message.allowedMentions.roleIds.map((roleId) =>
      DiscordSnowflake.parse(roleId),
    );
  }

  const payload: DiscordMessagePayload = {
    content: message.content,
    allowed_mentions: allowedMentions,
  };
  if (message.nonce !== undefined) {
    payload.nonce = message.nonce;
    payload.enforce_nonce = true;
  }
  if (message.embeds !== undefined) {
    payload.embeds = message.embeds.map(createEmbedPayload);
  }
  if (message.linkButtons !== undefined) {
    payload.components = [
      {
        type: MessageComponentTypes.ACTION_ROW,
        components: message.linkButtons.map((button) => ({
          type: MessageComponentTypes.BUTTON,
          style: ButtonStyleTypes.LINK,
          label: button.label,
          url: button.url,
        })),
      },
    ];
  }
  return payload;
}

function createEmbedPayload(
  embed: NonNullable<DiscordMessage['embeds']>[number],
): DiscordEmbedPayload {
  return {
    ...(embed.author === undefined
      ? {}
      : {
          author: {
            name: embed.author.name,
            ...(embed.author.iconUrl === undefined
              ? {}
              : { icon_url: embed.author.iconUrl }),
          },
        }),
    ...(embed.title === undefined ? {} : { title: embed.title }),
    ...(embed.url === undefined ? {} : { url: embed.url }),
    ...(embed.color === undefined ? {} : { color: embed.color }),
    ...(embed.fields === undefined ? {} : { fields: embed.fields }),
    ...(embed.thumbnail === undefined ? {} : { thumbnail: embed.thumbnail }),
    ...(embed.image === undefined ? {} : { image: embed.image }),
    ...(embed.footer === undefined ? {} : { footer: embed.footer }),
    ...(embed.timestamp === undefined ? {} : { timestamp: embed.timestamp }),
  };
}

async function executeDiscordMessageRequest(
  request: Request,
): Promise<DiscordMessageReceipt> {
  const response = await fetch(request);
  if (!response.ok) {
    const body = await response.text();
    throw new DiscordApiError(
      response.status,
      body.trim() === '' ? 'no response body' : body,
      parseRetryAfter(response.headers.get('retry-after')),
    );
  }
  return DiscordMessageReceipt.parse(await response.json());
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
