import { AutoRouter, type IRequest } from 'itty-router';

import type { DiscordMessageDelivery } from './queue/discord-message';
import { deliverDiscordMessageBatch } from './queue/discord-message';
import {
  handleYouTubeWebSubIntent,
  handleYouTubeWebSubNotification,
} from './youtube/websub-handler';

export { YouTubeSubscription } from './youtube-subscription/durable-object';

const router = AutoRouter<IRequest, [Env, ExecutionContext], Response>();

router
  .get('/youtube/websub/:channelId', handleYouTubeWebSubIntent)
  .post('/youtube/websub/:channelId', handleYouTubeWebSubNotification);

export default {
  fetch: router.fetch,

  async queue(
    batch: MessageBatch<DiscordMessageDelivery>,
    env: Env,
  ): Promise<void> {
    await deliverDiscordMessageBatch(batch, env);
  },
} satisfies ExportedHandler<Env, DiscordMessageDelivery>;
