import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';

import { subscribers } from '../../src/db/youtube-subscription/schema';
import { YouTubeChannelId } from '../../src/youtube/data';
import { createYouTubeTopicUrl } from '../../src/youtube/websub';
import type { YouTubeSubscription } from '../../src/youtube-subscription/durable-object';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '234567890123456789';
const OTHER_CHANNEL_ID = '345678901234567890';
const CHANNEL_TITLE = 'YouTube channel';
const WEBSUB_SECRET_KEY = 'websub:secret';
const WEBSUB_STATUS_KEY = 'websub:status';

let fetchSpy: MockInstance<typeof fetch>;
let hubRequests: Record<string, string>[];

beforeEach(() => {
  hubRequests = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    hubRequests.push(await readHubRequest(input));
    return new Response(null, { status: 202 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('YouTubeSubscription WebSub lifecycle', () => {
  it('subscribes once when the first subscriber is added', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);

    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      channelTitle: CHANNEL_TITLE,
    });
    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: OTHER_CHANNEL_ID,
      channelTitle: CHANNEL_TITLE,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(hubRequests[0]).toMatchObject({
      'hub.mode': 'subscribe',
      'hub.topic': createYouTubeTopicUrl(youtubeChannelId),
      'hub.callback': `https://bot.example.com/youtube/websub/${youtubeChannelId}`,
    });

    const state = await readWebSubState(subscription);
    expect(state.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(state.status).toBe('subscribing');
    expect(state.alarm).not.toBeNull();
  });

  it('confirms the lease and renews at eighty percent', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      channelTitle: CHANNEL_TITLE,
    });

    const beforeConfirmation = Date.now();
    await expect(
      subscription.confirmWebSubIntent(
        'subscribe',
        createYouTubeTopicUrl(youtubeChannelId),
        1000,
      ),
    ).resolves.toBe(true);
    const afterConfirmation = Date.now();

    const confirmed = await readWebSubState(subscription);
    expect(confirmed.status).toBe('subscribed');
    expect(confirmed.alarm).toBeGreaterThanOrEqual(
      beforeConfirmation + 800_000,
    );
    expect(confirmed.alarm).toBeLessThanOrEqual(afterConfirmation + 800_000);

    await expect(runDurableObjectAlarm(subscription)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(hubRequests[1]).toMatchObject({ 'hub.mode': 'subscribe' });
    expect((await readWebSubState(subscription)).status).toBe('subscribing');
  });

  it('unsubscribes only after the final subscriber is removed', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      channelTitle: CHANNEL_TITLE,
    });
    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: OTHER_CHANNEL_ID,
      channelTitle: CHANNEL_TITLE,
    });

    await subscription.removeSubscriber(CHANNEL_ID);
    expect(fetchSpy).toHaveBeenCalledOnce();

    await subscription.removeSubscriber(OTHER_CHANNEL_ID);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(hubRequests[1]).toMatchObject({ 'hub.mode': 'unsubscribe' });
    expect((await readWebSubState(subscription)).status).toBe('unsubscribing');

    await expect(
      subscription.confirmWebSubIntent(
        'unsubscribe',
        createYouTubeTopicUrl(youtubeChannelId),
      ),
    ).resolves.toBe(true);
    await expect(readWebSubState(subscription)).resolves.toEqual({
      alarm: null,
      secret: undefined,
      status: undefined,
    });
  });

  it('keeps subscriber and retry state when the hub request fails', async () => {
    fetchSpy.mockImplementationOnce(async (input: RequestInfo | URL) => {
      hubRequests.push(await readHubRequest(input));
      return new Response(null, { status: 503 });
    });
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      randomYouTubeChannelId(),
    );

    await expect(
      runInDurableObject(subscription, (instance: YouTubeSubscription) =>
        instance.addSubscriber({
          guildId: GUILD_ID,
          channelId: CHANNEL_ID,
          channelTitle: CHANNEL_TITLE,
        }),
      ),
    ).rejects.toThrow('YouTube WebSub hub returned HTTP 503');

    const subscriberRows = await runInDurableObject(
      subscription,
      async (_instance, state) =>
        drizzle(state.storage).select().from(subscribers),
    );
    expect(subscriberRows).toHaveLength(1);
    const state = await readWebSubState(subscription);
    expect(state.status).toBe('subscribing');
    expect(state.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(state.alarm).not.toBeNull();
  });

  it('rejects stale and mismatched confirmations', async () => {
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      channelTitle: CHANNEL_TITLE,
    });

    await expect(
      subscription.confirmWebSubIntent(
        'unsubscribe',
        createYouTubeTopicUrl(youtubeChannelId),
      ),
    ).resolves.toBe(false);
    await expect(
      subscription.confirmWebSubIntent(
        'subscribe',
        createYouTubeTopicUrl(
          YouTubeChannelId.parse('UCaaaaaaaaaaaaaaaaaaaaaa'),
        ),
        1000,
      ),
    ).resolves.toBe(false);
    expect((await readWebSubState(subscription)).status).toBe('subscribing');
  });

  it('clears state when the hub denies the intent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const youtubeChannelId = randomYouTubeChannelId();
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(youtubeChannelId);
    await subscription.addSubscriber({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      channelTitle: CHANNEL_TITLE,
    });

    await expect(
      subscription.denyWebSubIntent(
        createYouTubeTopicUrl(youtubeChannelId),
        'Topic unavailable',
      ),
    ).resolves.toBe(true);
    await expect(readWebSubState(subscription)).resolves.toEqual({
      alarm: null,
      secret: undefined,
      status: undefined,
    });
  });
});

function randomYouTubeChannelId(): YouTubeChannelId {
  return YouTubeChannelId.parse(
    `UC${crypto.randomUUID().replaceAll('-', '').slice(0, 22)}`,
  );
}

async function readHubRequest(
  input: RequestInfo | URL,
): Promise<Record<string, string>> {
  if (!(input instanceof Request)) {
    throw new Error('YouTubeSubscription did not send a Request to the hub');
  }

  return Object.fromEntries(
    Array.from(await input.formData(), ([key, value]) => {
      if (typeof value !== 'string') {
        throw new Error('YouTube WebSub request contains a file');
      }
      return [key, value];
    }),
  );
}

function readWebSubState(
  subscription: DurableObjectStub<YouTubeSubscription>,
): Promise<{
  secret: string | undefined;
  status: string | undefined;
  alarm: number | null;
}> {
  return runInDurableObject(subscription, async (_instance, state) => {
    const values = await state.storage.get<string>([
      WEBSUB_SECRET_KEY,
      WEBSUB_STATUS_KEY,
    ]);
    return {
      secret: values.get(WEBSUB_SECRET_KEY),
      status: values.get(WEBSUB_STATUS_KEY),
      alarm: await state.storage.getAlarm(),
    };
  });
}
