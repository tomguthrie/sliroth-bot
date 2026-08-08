import { AutoRouter, type IRequest } from 'itty-router';

import { handleDiscordInteraction } from './discord/interactions';
import type { DiscordMessageDelivery } from './queue/discord-message';
import { deliverDiscordMessageBatch } from './queue/discord-message';
import {
  handleYouTubeWebSubIntent,
  handleYouTubeWebSubNotification,
} from './youtube/websub-handler';
import { handleTwitchEventSub } from './twitch/eventsub-handler';

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
  queue: deliverDiscordMessageBatch,
} satisfies ExportedHandler<Env, DiscordMessageDelivery>;
