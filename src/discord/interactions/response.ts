import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';

import { DISCORD_API_BASE_URL } from '../request';
import type { DiscordSnowflake } from '../snowflake';
import type { DiscordInteractionToken } from './data';

/** Creates an immediate ephemeral interaction response. */
export function ephemeralInteractionResponse(content: string): Response {
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: InteractionResponseFlags.EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
}

/** Defers an interaction while preserving its ephemeral visibility. */
export function deferredEphemeralInteractionResponse(): Response {
  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });
}

/** Replaces the original response to a deferred interaction. */
export async function editInteractionResponse(
  applicationId: DiscordSnowflake,
  token: DiscordInteractionToken,
  content: string,
): Promise<void> {
  const response = await fetch(
    new URL(
      `webhooks/${applicationId}/${encodeURIComponent(token)}/messages/@original`,
      DISCORD_API_BASE_URL,
    ),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
      }),
    },
  );
  if (!response.ok) {
    if (response.body !== null) {
      await response.body.cancel();
    }
    throw new Error(
      `Discord interaction response returned HTTP ${response.status}`,
    );
  }
  if (response.body !== null) {
    await response.body.cancel();
  }
}
