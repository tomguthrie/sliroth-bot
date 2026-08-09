import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';

import { handleYouTubeCommand, YOUTUBE_COMMAND_NAME } from './command/youtube';
import { handleTwitchCommand, TWITCH_COMMAND_NAME } from './command/twitch';
import { DiscordInteraction } from './data';
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

  const interaction = await parseJson(body);
  if (interaction === undefined || typeof interaction.type !== 'number') {
    return new Response('Bad Request', { status: 400 });
  }
  if (interaction.type === Number(InteractionType.PING)) {
    return Response.json({ type: InteractionResponseType.PONG });
  }
  if (interaction.type !== Number(InteractionType.APPLICATION_COMMAND)) {
    return ephemeralInteractionResponse('This interaction is not supported.');
  }

  if (interaction.data?.name === YOUTUBE_COMMAND_NAME) {
    return handleYouTubeCommand(interaction, env, ctx);
  }
  if (interaction.data?.name === TWITCH_COMMAND_NAME) {
    return handleTwitchCommand(interaction, env, ctx);
  }
  return ephemeralInteractionResponse('This interaction is not supported.');
}

async function parseJson(
  bytes: Uint8Array,
): Promise<DiscordInteraction | undefined> {
  try {
    const result = DiscordInteraction.safeParse(
      await new Response(bytes).json(),
    );
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
