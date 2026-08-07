export { YouTubeSubscription } from './durable-object/youtube-subscription';

export default {
  fetch(): Response {
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
