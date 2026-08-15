import { AutoRouter, type IRequest } from 'itty-router';

import { createDiscordInteractionHandler } from './discord';
import { deliverQueueBatch, type WorkerQueueMessage } from './queue';
import { handleTwitchEventSub, twitchDiscordCommand } from './twitch';
import {
  handleYouTubeWebSubIntent,
  handleYouTubeWebSubNotification,
  youtubeDiscordCommand,
} from './youtube';

export { TwitchSubscription } from './twitch';
export { YouTubeSubscription } from './youtube';

const handleDiscordInteraction = createDiscordInteractionHandler([
  twitchDiscordCommand,
  youtubeDiscordCommand,
]);

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
