import type { DiscordMessageReceipt } from '../discord/client';
import { TwitchBroadcasterId, TwitchStreamId } from '../twitch/data';

/** Records a Twitch stream's Discord create-message receipt. */
export async function recordTwitchStreamMessageReceipt(
  broadcasterId: string,
  streamId: string,
  receipt: DiscordMessageReceipt,
  env: Env,
): Promise<void> {
  await env.TWITCH_SUBSCRIPTIONS.getByName(
    TwitchBroadcasterId.parse(broadcasterId),
  ).recordDiscordMessage(TwitchStreamId.parse(streamId), receipt);
}
