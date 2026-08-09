import type { DiscordMessageReceipt } from '../discord/client';

/** Records a Twitch stream's Discord create-message receipt. */
export async function recordTwitchStreamMessageReceipt(
  broadcasterId: string,
  streamId: string,
  receipt: DiscordMessageReceipt,
  env: Env,
): Promise<void> {
  if (broadcasterId.trim() === '' || streamId.trim() === '')
    throw new Error('Invalid Twitch stream receipt target');
  await env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId).recordDiscordMessage(
    streamId,
    receipt,
  );
}
