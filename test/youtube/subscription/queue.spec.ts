import { env, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { videos } from '../../../src/db/youtube-subscription/schema';
import type { QueueMessageContext } from '../../../src/queue/message';
import {
  processYouTubeSubscriptionEvent,
  type YouTubeVideoDelivery,
} from '../../../src/youtube/subscription/queue';

describe('YouTube subscription Queue processing', () => {
  it('records the notification in its channel subscription', async () => {
    const channelId = `UC${crypto.randomUUID().replaceAll('-', '').slice(0, 22)}`;
    const delivery: YouTubeVideoDelivery = {
      kind: 'youtube-video',
      channelId,
      notification: {
        videoId: 'dQw4w9WgXcQ',
        channelId,
        title: 'A YouTube video',
        publishedAt: '2026-08-07T12:34:56.789Z',
      },
    };
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      delivery.channelId,
    );

    const result = await processYouTubeSubscriptionEvent(
      delivery,
      env,
      CONTEXT,
    );

    expect(result).toEqual({ action: 'ack' });
    const [stored] = await runInDurableObject(
      subscription,
      async (_instance, state) =>
        drizzle(state.storage)
          .select()
          .from(videos)
          .where(eq(videos.id, delivery.notification.videoId)),
    );
    expect(stored?.title).toBe(delivery.notification.title);
  });
});

const CONTEXT: QueueMessageContext = {
  queue: 'subscription-events',
  messageId: 'youtube-video',
  attempt: 1,
  enqueuedAt: new Date('2026-08-07T12:34:56.789Z'),
  startedAt: Date.now(),
};
