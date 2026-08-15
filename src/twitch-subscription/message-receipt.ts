import type { DiscordMessageReceipt } from '../discord';

/** Records a Twitch stream's Discord create-message receipt. */
export async function recordTwitchStreamMessageReceipt(
  broadcasterId: string,
  streamId: string,
  receipt: DiscordMessageReceipt,
  env: Env,
): Promise<void> {
  await env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId).recordDiscordMessage(
    streamId,
    receipt,
  );
}
