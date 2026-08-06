export { YouTubeSubscription } from './durable/youtube-subscription';

export const YOUTUBE_SUBSCRIPTION_NAME = 'primary';

export default {
  fetch(_request, _env, _ctx): Response {
    return new Response('Hello World!');
  },

  async scheduled(_controller, env, _ctx): Promise<void> {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(
      YOUTUBE_SUBSCRIPTION_NAME,
    );

    await subscription.ensureInitialized(env.YOUTUBE_CHANNEL_ID);
  },
} satisfies ExportedHandler<Env>;
