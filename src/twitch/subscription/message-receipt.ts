import * as z from 'zod';

import type { DiscordMessageReceiptHandler } from '../../discord/queue';

export const TWITCH_STREAM_MESSAGE_RECEIPT = 'twitch-stream';

const TwitchStreamMessageReceiptTarget = z.object({
  type: z.literal(TWITCH_STREAM_MESSAGE_RECEIPT),
  broadcasterId: z.string().regex(/^\d+$/),
  streamId: z.string().trim().min(1),
});

/** Records Discord's receipt in the Twitch subscription that owns the stream. */
export const twitchStreamMessageReceiptHandler: DiscordMessageReceiptHandler = async (
  target,
  receipt,
  env,
) => {
  const { broadcasterId, streamId } = TwitchStreamMessageReceiptTarget.parse(target);
  await env.TWITCH_SUBSCRIPTIONS.getByName(broadcasterId).recordDiscordMessage(streamId, receipt);
};
