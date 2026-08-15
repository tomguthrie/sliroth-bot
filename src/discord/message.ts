import * as z from 'zod';

import { DiscordSnowflake } from './snowflake';

const MAX_DISCORD_NONCE_LENGTH = 25;
const MAX_MESSAGE_CONTENT_LENGTH = 2_000;

/** A persisted notification mention selected through a Discord command. */
export const DiscordMentionTarget = z.union([
  z.literal('everyone'),
  z.literal('here'),
  DiscordSnowflake,
]);

export type DiscordMentionTarget = z.infer<typeof DiscordMentionTarget>;

/** The Discord message features used by notification deliveries. */
export interface DiscordMessage {
  content: string;
  nonce?: string;
  allowedMentions?: {
    roleIds?: string[];
    everyone?: boolean;
  };
  embeds?: {
    author?: { name: string; iconUrl?: string };
    title?: string;
    url?: string;
    color?: number;
    fields?: { name: string; value: string; inline?: boolean }[];
    thumbnail?: { url: string };
    image?: { url: string };
    footer?: { text: string };
    timestamp?: string;
  }[];
  linkButtons?: { label: string; url: string }[];
}

export interface DiscordMentionPayload {
  content?: string;
  allowedMentions?: DiscordMessage['allowedMentions'];
}

export interface NotificationListItem {
  name: string;
  channelId: string;
  providerId: string;
}

/** Derives notification content and the matching Discord mention allowlist. */
export function createDiscordMentionPayload(
  ping: DiscordMentionTarget | null,
): DiscordMentionPayload {
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

/** Derives Discord's short idempotency nonce for a notification delivery. */
export async function createDiscordMessageNonce(
  sourceId: string,
  channelId: string,
): Promise<string> {
  const value = new TextEncoder().encode(`${sourceId}:${channelId}`);
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .slice(0, MAX_DISCORD_NONCE_LENGTH);
}

/** Produces a stable, preview-free subscription list within Discord's limit. */
export function createNotificationList(
  heading: string,
  items: readonly NotificationListItem[],
  currentChannelId: string,
): string {
  const rows = [...items]
    .sort((left, right) => {
      const leftCurrent = left.channelId === currentChannelId;
      const rightCurrent = right.channelId === currentChannelId;
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      return (
        left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) ||
        left.channelId.localeCompare(right.channelId) ||
        left.providerId.localeCompare(right.providerId)
      );
    })
    .map(
      ({ name, channelId }) =>
        `${escapeDiscordMarkdown(name)} → <#${channelId}>${channelId === currentChannelId ? '*' : ''}`,
    );

  const lines = [heading];
  for (const [index, row] of rows.entries()) {
    const omittedAfterRow = rows.length - index - 1;
    const candidate = [
      ...lines,
      row,
      ...(omittedAfterRow === 0 ? [] : [`…and ${omittedAfterRow} more.`]),
    ].join('\n');
    if (candidate.length > MAX_MESSAGE_CONTENT_LENGTH) {
      lines.push(`…and ${rows.length - index} more.`);
      break;
    }
    lines.push(row);
  }
  return lines.join('\n');
}

export function describeDiscordMention(
  ping: DiscordMentionTarget | undefined,
): string {
  if (ping === undefined) return '';
  if (ping === 'everyone' || ping === 'here') return ` and mention @${ping}`;
  return ` and mention <@&${ping}>`;
}

export function escapeDiscordMarkdown(value: string): string {
  return value.replaceAll(/([\\`*_{}[\]()<>#+\-.!|~])/g, '\\$1');
}
