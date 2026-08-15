import * as z from 'zod';

import { DiscordSnowflake } from './snowflake';

const MAX_DISCORD_NONCE_LENGTH = 25;

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
