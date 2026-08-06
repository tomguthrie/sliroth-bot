import { env, exports } from 'cloudflare:workers';
import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { YOUTUBE_SUBSCRIPTION_NAME } from '../src/index';
import type { SubscriptionState } from '../src/durable/youtube-subscription';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Hello World worker', () => {
  it('responds with Hello World! (unit style)', async () => {
    const request = new IncomingRequest('http://example.com');
    // Create an empty context to pass to `worker.fetch()`.
    const ctx = createExecutionContext();
    const response = worker.fetch(request, env, ctx);
    // Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
    await waitOnExecutionContext(ctx);
    expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
  });

  it('responds with Hello World! (integration style)', async () => {
    const response = await exports.default.fetch('https://example.com');
    expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
  });

  it('initializes the YouTube subscription on schedule', async () => {
    const controller = createScheduledController({
      cron: '*/15 * * * *',
      scheduleTime: new Date(0),
    });
    const ctx = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      YOUTUBE_SUBSCRIPTION_NAME,
    );

    const persisted = await runInDurableObject(
      subscription,
      (_instance, state) =>
        state.storage.kv.get<SubscriptionState>('subscription'),
    );

    expect(persisted).toMatchObject({
      schemaVersion: 1,
      phase: 'uninitialized',
      channelId: env.YOUTUBE_CHANNEL_ID,
      requestedAtMs: null,
    });

    expect(typeof persisted?.createdAtMs).toBe('number');
  });
});
