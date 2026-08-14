import { AutoRouter, type IRequest } from 'itty-router';

import { handleDiscordInteraction } from './discord';
import { deliverQueueBatch, type WorkerQueueMessage } from './queue';
import { handleTwitchEventSub } from './twitch-subscription/eventsub-handler';
import {
  handleYouTubeWebSubIntent,
  handleYouTubeWebSubNotification,
} from './youtube-subscription/websub-handler';

export { YouTubeSubscription } from './youtube-subscription/durable-object';
export { TwitchSubscription } from './twitch-subscription/durable-object';

const router = AutoRouter<IRequest, [Env, ExecutionContext], Response>();

router
  .post('/discord/interactions', handleDiscordInteraction)
  .post('/twitch/eventsub/:broadcasterId', handleTwitchEventSub)
  .get('/youtube/websub/:channelId', handleYouTubeWebSubIntent)
  .post('/youtube/websub/:channelId', handleYouTubeWebSubNotification);

export default {
  fetch: router.fetch,
  queue: deliverQueueBatch,
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
