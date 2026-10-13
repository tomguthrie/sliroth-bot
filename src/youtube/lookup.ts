import * as z from 'zod';

import { createSubscriptionLookup } from '../subscription-lookup';
import { isYouTubeChannelId } from './channel';

const YouTubeSubscriptionMetadata = z.object({
  title: z.string().trim().min(1),
});

/** KV lookups from Discord guilds and channels to YouTube channel subscriptions. */
export const youtubeSubscriptionLookup = createSubscriptionLookup(
  'youtube',
  isYouTubeChannelId,
  YouTubeSubscriptionMetadata,
);
