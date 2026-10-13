import { AutoRouter, type IRequest } from 'itty-router';

import { createDiscordInteractionHandler } from './discord/interaction';
import { deliverQueueBatch, type WorkerQueueMessage } from './queue';
import { twitchDiscordCommand } from './twitch/discord-command';
import { handleTwitchEventSub } from './twitch/eventsub-handler';
import { youtubeDiscordCommand } from './youtube/discord-command';
import {
  handleYouTubeWebSubIntent,
  handleYouTubeWebSubNotification,
} from './youtube/websub-handler';

export { TwitchSubscription } from './twitch/durable-object';
export { YouTubeSubscription } from './youtube/durable-object';

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
