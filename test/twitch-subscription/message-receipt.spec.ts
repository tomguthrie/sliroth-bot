import { env, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { streamMessages } from '../../src/db/twitch-subscription/schema';
import { recordTwitchStreamMessageReceipt } from '../../src/twitch-subscription/message-receipt';

const BROADCASTER_ID = '123456789012345678';
const CHANNEL_ID = '234567890123456789';
const MESSAGE_ID = '345678901234567890';

describe('Twitch stream message receipts', () => {
  it('records a receipt in its broadcaster object', async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(BROADCASTER_ID);
    await runInDurableObject(subscription, async (_instance, state) => {
      await drizzle(state.storage).insert(streamMessages).values({
        streamId,
        channelId: CHANNEL_ID,
      });
    });

    await recordTwitchStreamMessageReceipt(
      BROADCASTER_ID,
      streamId,
      { channelId: CHANNEL_ID, messageId: MESSAGE_ID },
      env,
    );

    const [stored] = await runInDurableObject(
      subscription,
      async (_instance, state) =>
        drizzle(state.storage)
          .select()
          .from(streamMessages)
          .where(eq(streamMessages.streamId, streamId)),
    );
    expect(stored?.messageId).toBe(MESSAGE_ID);
  });
});
