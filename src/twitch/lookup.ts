import * as z from 'zod';

import { createSubscriptionLookup } from '../subscription-lookup';
import { isTwitchBroadcasterId } from './channel';

const TwitchSubscriptionMetadata = z.object({
  login: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
});

/** KV lookups from Discord guilds and channels to Twitch broadcaster subscriptions. */
export const twitchSubscriptionLookup = createSubscriptionLookup(
  'twitch',
  isTwitchBroadcasterId,
  TwitchSubscriptionMetadata,
);
