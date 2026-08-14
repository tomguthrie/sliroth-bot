import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';

import { handleTwitchCommand, TWITCH_COMMAND_NAME } from './commands/twitch';
import {
  DiscordInteraction,
  unsupportedInteractionResponse,
} from './commands/shared';
import { handleYouTubeCommand, YOUTUBE_COMMAND_NAME } from './commands/youtube';

const PING_INTERACTION_TYPE: number = InteractionType.PING;
const APPLICATION_COMMAND_INTERACTION_TYPE: number =
  InteractionType.APPLICATION_COMMAND;

/** Authenticates and dispatches Discord interaction webhooks. */
export async function handleDiscordInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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

  if (interaction.data?.name === YOUTUBE_COMMAND_NAME) {
    return handleYouTubeCommand(interaction, env, ctx);
  }
  if (interaction.data?.name === TWITCH_COMMAND_NAME) {
    return handleTwitchCommand(interaction, env, ctx);
  }
  return unsupportedInteractionResponse();
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
