export const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';

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
}

export interface CreateDiscordMessageRequestOptions {
  botToken: string;
  channelId: string;
  applicationUrl: string;
  message: DiscordMessage;
}

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

  const allowedMentions: {
    parse: ['everyone'] | [];
    roles?: string[];
    users?: string[];
  } = {
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

  const applicationOrigin = new URL(applicationUrl).origin;

  const body = {
    content: message.content,
    ...(message.nonce === undefined
      ? {}
      : { nonce: message.nonce, enforce_nonce: true }),
    allowed_mentions: allowedMentions,
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

function requireNonEmpty(value: string, name: string): void {
  if (value.trim() === '') {
    throw new Error(`${name} cannot be empty`);
  }
}

function requireSnowflake(value: string, name: string): void {
  if (!/^[0-9]{17,20}$/.test(value)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
}

export async function sendDiscordMessage(
  options: CreateDiscordMessageRequestOptions,
): Promise<void> {
  const request = createDiscordMessageRequest(options);
  const response = await fetch(request);

  if (!response.ok) {
    const responseBody = await response.text();
    const detail =
      responseBody.trim() === '' ? 'no response body' : responseBody;

    throw new Error(
      `Discord rejected the message with HTTP ${response.status}: ${detail}`,
    );
  }

  if (response.body !== null) {
    await response.body.cancel();
  }
}
