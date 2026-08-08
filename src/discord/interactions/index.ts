import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';

import { handleYouTubeCommand } from './command/youtube';
import { isInteractionRecord } from './data';
import { ephemeralInteractionResponse } from './response';

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

  const interaction = parseJson(body);
  if (
    !isInteractionRecord(interaction) ||
    typeof interaction.type !== 'number'
  ) {
    return new Response('Bad Request', { status: 400 });
  }
  if (interaction.type === Number(InteractionType.PING)) {
    return Response.json({ type: InteractionResponseType.PONG });
  }
  if (interaction.type !== Number(InteractionType.APPLICATION_COMMAND)) {
    return ephemeralInteractionResponse('This interaction is not supported.');
  }

  return handleYouTubeCommand(interaction, env, ctx);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
