import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import * as z from 'zod';

import { toLoggableError } from '../log';
import { DISCORD_API_BASE_URL } from './client';
import { DiscordSnowflake } from './snowflake';

const PING_INTERACTION_TYPE: number = InteractionType.PING;
const APPLICATION_COMMAND_INTERACTION_TYPE: number =
  InteractionType.APPLICATION_COMMAND;

const DiscordPermissions = z.string().regex(/^\d+$/);
const DiscordResolvedRole = z.object({ mentionable: z.boolean().optional() });

export const DiscordInteraction = z.object({
  type: z.number(),
  application_id: DiscordSnowflake.optional(),
  token: z.string().min(1).optional(),
  guild_id: DiscordSnowflake.optional(),
  channel_id: DiscordSnowflake.optional(),
  channel: z.object({ type: z.number() }).optional(),
  app_permissions: DiscordPermissions.optional(),
  member: z.object({ permissions: DiscordPermissions.optional() }).optional(),
  data: z
    .object({
      name: z.string(),
      options: z.array(z.unknown()).optional(),
      resolved: z
        .object({
          roles: z.record(DiscordSnowflake, DiscordResolvedRole).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type DiscordInteraction = z.infer<typeof DiscordInteraction>;

export interface DiscordCommandHandler {
  readonly name: string;
  readonly handle: (
    interaction: DiscordInteraction,
    env: Env,
    ctx: ExecutionContext,
  ) => Promise<Response>;
}

/** Creates an authenticated Discord webhook handler for application commands. */
export function createDiscordInteractionHandler(
  commands: readonly DiscordCommandHandler[],
): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> {
  const commandsByName = new Map<string, DiscordCommandHandler>();
  for (const command of commands) {
    if (commandsByName.has(command.name)) {
      throw new Error(`Duplicate Discord command: ${command.name}`);
    }
    commandsByName.set(command.name, command);
  }

  return async (request, env, ctx) => {
    const body = new Uint8Array(await request.arrayBuffer());
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    if (
      signature === null ||
      timestamp === null ||
      !(await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))
    ) {
      return new Response('Invalid request signature', { status: 401 });
    }

    const interaction = parseInteraction(body);
    if (interaction === undefined) {
      return new Response('Bad Request', { status: 400 });
    }
    if (interaction.type === PING_INTERACTION_TYPE) {
      return Response.json({ type: InteractionResponseType.PONG });
    }
    if (interaction.type !== APPLICATION_COMMAND_INTERACTION_TYPE) {
      return unsupportedInteractionResponse();
    }

    const command =
      interaction.data === undefined
        ? undefined
        : commandsByName.get(interaction.data.name);
    return command === undefined
      ? unsupportedInteractionResponse()
      : command.handle(interaction, env, ctx);
  };
}

function parseInteraction(bytes: Uint8Array) {
  try {
    const result = DiscordInteraction.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Creates an immediate response visible only to the command invoker. */
export function createEphemeralResponse(content: string): Response {
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: InteractionResponseFlags.EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
}

/** Acknowledges a command whose final response will be written asynchronously. */
export function createDeferredResponse(): Response {
  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });
}

export function unsupportedInteractionResponse(): Response {
  return createEphemeralResponse('This interaction is not supported.');
}

/** Replaces the original response to a deferred interaction. */
export async function editInteractionResponse(
  applicationId: string,
  token: string,
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
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    },
  );
  if (!response.ok) {
    if (response.body !== null) await response.body.cancel();
    throw new Error(
      `Discord interaction response returned HTTP ${response.status}`,
    );
  }
  if (response.body !== null) await response.body.cancel();
}

export function logCommandFailure(
  provider: string,
  action: string,
  context: { guildId: string; channelId: string },
  error: unknown,
): void {
  console.error({
    event: 'discord_interaction_failed',
    provider,
    action,
    guildId: context.guildId,
    channelId: context.channelId,
    error: toLoggableError(error),
  });
}
