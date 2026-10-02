import { bindings, defineConfig, defineWorker, exports, triggers } from 'cf/config';

import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// Define the module before its self-bindings so Durable Object RPC types can be inferred.
const worker = defineWorker({
  name: 'sliroth-bot',
  entrypoint,
  compatibilityDate: '2026-08-06',
  compatibilityFlags: ['nodejs_compat'],
  observability: {
    enabled: true,
    logs: { headSamplingRate: 1 },
    traces: { enabled: true },
  },
  triggers: [
    triggers.queue({
      name: 'discord-messages',
      maxBatchSize: 10,
      maxBatchTimeout: 0,
      maxRetries: 5,
      deadLetterQueue: 'discord-messages-dlq',
      maxConcurrency: 1,
      retryDelay: 30,
    }),
    triggers.queue({
      name: 'subscription-events',
      maxBatchSize: 1,
      maxBatchTimeout: 0,
      maxRetries: 5,
      deadLetterQueue: 'subscription-events-dlq',
      retryDelay: 30,
    }),
  ],
  exports: {
    YouTubeSubscription: exports.durableObject({ storage: 'sqlite' }),
    TwitchSubscription: exports.durableObject({ storage: 'sqlite' }),
  },
});

/** Defines the Worker runtime and its typed bindings. */
export default defineConfig({
  worker: {
    ...worker,
    env: {
      DISCORD_BOT_TOKEN: bindings.secret(),
      DISCORD_PUBLIC_KEY: bindings.secret(),
      PUBLIC_BASE_URL: bindings.secret(),
      TWITCH_CLIENT_ID: bindings.secret(),
      TWITCH_CLIENT_SECRET: bindings.secret(),
      TWITCH_EVENTSUB_SECRET: bindings.secret(),
      TOKEN_STORE: bindings.kv(),
      TWITCH_SUBSCRIPTIONS_INDEX: bindings.kv(),
      YOUTUBE_SUBSCRIPTIONS_INDEX: bindings.kv(),
      DISCORD_MESSAGES: bindings.queue({ name: 'discord-messages' }),
      SUBSCRIPTION_EVENTS: bindings.queue({ name: 'subscription-events' }),
      YOUTUBE_SUBSCRIPTIONS: bindings.durableObject<typeof worker, 'YouTubeSubscription'>({
        worker,
        exportName: 'YouTubeSubscription',
      }),
      TWITCH_SUBSCRIPTIONS: bindings.durableObject<typeof worker, 'TwitchSubscription'>({
        worker,
        exportName: 'TwitchSubscription',
      }),
    },
  },
});
