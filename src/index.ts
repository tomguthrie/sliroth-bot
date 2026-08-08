import type { DiscordMessageDelivery } from './queue/discord-message';
import { deliverDiscordMessageBatch } from './queue/discord-message';

export { YouTubeSubscription } from './youtube-subscription/durable-object';

export default {
  fetch(): Response {
    return new Response('Not Found', { status: 404 });
  },

  async queue(
    batch: MessageBatch<DiscordMessageDelivery>,
    env: Env,
  ): Promise<void> {
    await deliverDiscordMessageBatch(batch, env);
  },
} satisfies ExportedHandler<Env, DiscordMessageDelivery>;
