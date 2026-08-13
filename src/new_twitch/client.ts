import * as z from 'zod';

import { getAccessToken } from './auth';

class TwitchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAtMs?: number,
  ) {
    super(message);
    this.name = 'TwitchApiError';
  }
}

const TwitchUser = z
  .object({
    id: z.string(),
    login: z.string(),
    display_name: z.string(),
    profile_image_url: z.url(),
    offline_image_url: z.url(),
  })
  .transform((data) => ({
    id: data.id,
    login: data.login,
    displayName: data.display_name,
    profileImageUrl: data.profile_image_url,
    offlineImageUrl: data.offline_image_url,
  }));

/** A Twitch user returned by the Helix API. */
export type TwitchUser = z.infer<typeof TwitchUser>;

const TwitchStream = z
  .object({
    id: z.string(),
    user_id: z.string(),
    user_login: z.string(),
    user_name: z.string(),
    game_id: z.string(),
    game_name: z.string(),
    title: z.string(),
    viewer_count: z.number().int(),
    started_at: z.iso.datetime().transform((str) => new Date(str)),
    thumbnail_url: z.url(),
  })
  .transform((data) => ({
    id: data.id,
    broadcasterId: data.user_id,
    broadcasterLogin: data.user_login,
    broadcasterName: data.user_name,
    gameId: data.game_id,
    gameName: data.game_name,
    title: data.title,
    viewerCount: data.viewer_count,
    startedAt: data.started_at,
    thumbnailUrl: data.thumbnail_url,
  }));

/** A live Twitch stream returned by the Helix API. */
export type TwitchStream = z.infer<typeof TwitchStream>;

const TwitchGame = z
  .object({
    id: z.string(),
    name: z.string(),
    box_art_url: z.url(),
  })
  .transform((data) => ({
    id: data.id,
    name: data.name,
    boxArtUrl: data.box_art_url,
  }));

/** A Twitch game or category returned by the Helix API. */
export type TwitchGame = z.infer<typeof TwitchGame>;

export const TwitchVideo = z
  .object({
    id: z.string(),
    stream_id: z.string(),
    user_id: z.string(),
    user_login: z.string(),
    user_name: z.string(),
    title: z.string(),
    description: z.string(),
    created_at: z.iso.datetime().transform((str) => new Date(str)),
    published_at: z.iso.datetime().transform((str) => new Date(str)),
    url: z.url(),
    thumbnail_url: z.url(),
    viewable: z.enum(['public', 'private', 'unlisted']),
    view_count: z.number().int(),
    language: z.string(),
    type: z.enum(['archive', 'highlight', 'upload']),
    duration: z.string(),
  })
  .transform((data) => ({
    id: data.id,
    streamId: data.stream_id,
    broadcasterId: data.user_id,
    broadcasterLogin: data.user_login,
    broadcasterName: data.user_name,
    title: data.title,
    description: data.description,
    createdAt: data.created_at,
    publishedAt: data.published_at,
    url: data.url,
    thumbnailUrl: data.thumbnail_url,
    viewable: data.viewable,
    viewCount: data.view_count,
    language: data.language,
    type: data.type,
    duration: data.duration,
  }));

/** A Twitch video (VOD) returned by the Helix API. */
export type TwitchVideo = z.infer<typeof TwitchVideo>;

const CreateEventSubSubscription = z.object({
  type: z.string(),
  version: z.string(),
  condition: z.record(z.string(), z.string()),
  transport: z.object({
    method: z.literal('webhook'),
    callback: z.url(),
    secret: z.string().min(10).max(100),
  }),
});

type CreateEventSubSubscription = z.input<typeof CreateEventSubSubscription>;

const TwitchEventSubSubscription = z
  .object({
    id: z.string(),
    status: z.string(),
    type: z.string(),
    version: z.string(),
    condition: z.record(z.string(), z.string()),
    transport: z.object({
      method: z.literal('webhook'),
      callback: z.url(),
    }),
    created_at: z.iso.datetime().transform((value) => new Date(value)),
    cost: z.number().int().nonnegative(),
  })
  .transform((data) => ({
    id: data.id,
    status: data.status,
    type: data.type,
    version: data.version,
    condition: data.condition,
    transport: {
      method: data.transport.method,
      callback: data.transport.callback,
    },
    createdAt: data.created_at,
    cost: data.cost,
  }));

type TwitchEventSubSubscription = z.output<typeof TwitchEventSubSubscription>;

/**
 * Client for authenticated requests to the Twitch Helix API.
 *
 * @throws {TwitchApiError} When Twitch returns an unsuccessful HTTP response.
 * @throws {z.ZodError} When Twitch returns a response that does not match the
 * expected schema.
 */
export class TwitchApiClient {
  private accessToken: Promise<string> | undefined;

  /**
   * Creates a Twitch API client using the supplied Cloudflare Worker bindings.
   *
   * @param env Worker bindings containing Twitch credentials and token storage.
   */
  constructor(private readonly env: Env) {}

  private async getAccessToken(): Promise<string> {
    return (this.accessToken ??= getAccessToken(this.env));
  }

  private async fetch(
    path: string,
    init?: RequestInit,
    retryOnUnauthorized = true,
  ): Promise<Response> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(`https://api.twitch.tv/helix/${path}`, {
      ...init,
      headers: {
        'Client-ID': this.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
        ...init?.headers,
      },
    });

    if (response.status === 401 && retryOnUnauthorized) {
      this.accessToken = undefined;

      return this.fetch(path, init, false);
    }

    if (!response.ok) {
      throw await this.createApiError(response);
    }

    return response;
  }

  private async createApiError(response: Response): Promise<TwitchApiError> {
    let message = response.statusText;

    try {
      const body = z
        .object({
          message: z.string(),
        })
        .parse(await response.json());

      message = body.message;
    } catch {
      // Keep statusText if Twitch didn't return the expected JSON error shape.
    }

    const reset = response.headers.get('ratelimit-reset');

    const retryAtMs =
      reset !== null && /^\d+$/.test(reset) ? Number(reset) * 1000 : undefined;

    return new TwitchApiError(
      `Twitch API returned HTTP ${response.status}: ${message}`,
      response.status,
      retryAtMs,
    );
  }

  private async request<T extends z.ZodType>(
    path: string,
    schema: T,
    init?: RequestInit,
  ): Promise<z.output<T>[]> {
    const response = await this.fetch(path, init);

    return z
      .object({
        data: z.array(schema),
      })
      .parse(await response.json()).data;
  }

  private async requestOne<T extends z.ZodType>(
    path: string,
    schema: T,
  ): Promise<z.output<T> | undefined> {
    const [result] = await this.request(path, schema);
    return result;
  }

  private async requestEmpty(path: string, init?: RequestInit): Promise<void> {
    await this.fetch(path, init);
  }

  /**
   * Gets a Twitch user by broadcaster ID.
   *
   * @param userId Twitch user ID to look up.
   * @returns The matching user, or `undefined` if no user exists with that ID.
   */
  async getUserById(userId: string): Promise<TwitchUser | undefined> {
    return this.requestOne(
      `users?id=${encodeURIComponent(userId)}`,
      TwitchUser,
    );
  }

  /**
   * Gets a Twitch user by login name.
   *
   * @param login Twitch login name to look up.
   * @returns The matching user, or `undefined` if no user exists with that login.
   */
  async getUserByLogin(login: string): Promise<TwitchUser | undefined> {
    return this.requestOne(
      `users?login=${encodeURIComponent(login)}`,
      TwitchUser,
    );
  }

  /**
   * Gets the current live stream for a broadcaster.
   *
   * @param broadcasterId Twitch user ID of the broadcaster.
   * @returns The live stream, or `undefined` if the broadcaster is offline.
   */
  async getStream(broadcasterId: string): Promise<TwitchStream | undefined> {
    return this.requestOne(
      `streams?user_id=${encodeURIComponent(broadcasterId)}`,
      TwitchStream,
    );
  }

  /**
   * Gets a Twitch game or category by ID.
   *
   * @param gameId Twitch game or category ID.
   * @returns The matching game, or `undefined` if no game exists with that ID.
   */
  async getGame(gameId: string): Promise<TwitchGame | undefined> {
    return this.requestOne(
      `games?id=${encodeURIComponent(gameId)}`,
      TwitchGame,
    );
  }

  /**
   * Gets the most recent archive videos (VODs) for a broadcaster.
   *
   * @param broadcasterId Twitch user ID of the broadcaster.
   * @param first Maximum number of videos to return (default: 20).
   * @returns Archive videos, or an empty array if the broadcaster has no VODs.
   */
  async getVideos(broadcasterId: string, first = 20): Promise<TwitchVideo[]> {
    return this.request(
      `videos?user_id=${encodeURIComponent(broadcasterId)}&type=archive&first=${first}`,
      TwitchVideo,
    );
  }

  /**
   * Creates a webhook EventSub subscription.
   *
   * @param subscription Subscription type, condition, and webhook transport.
   * @returns The subscription created by Twitch.
   * @throws {Error} If Twitch accepts the request but returns no subscription.
   */
  async createEventSubSubscription(
    subscription: CreateEventSubSubscription,
  ): Promise<TwitchEventSubSubscription> {
    const [result] = await this.request(
      'eventsub/subscriptions',
      TwitchEventSubSubscription,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(subscription),
      },
    );

    if (!result) {
      throw new Error('Twitch did not return an EventSub subscription');
    }

    return result;
  }

  /**
   * Gets an EventSub subscription by ID.
   *
   * @param subscriptionId EventSub subscription ID.
   * @returns The matching subscription, or `undefined` if none is returned.
   */
  async getEventSubSubscription(
    subscriptionId: string,
  ): Promise<TwitchEventSubSubscription | undefined> {
    return this.requestOne(
      `eventsub/subscriptions?id=${encodeURIComponent(subscriptionId)}`,
      TwitchEventSubSubscription,
    );
  }

  /**
   * Deletes an EventSub subscription.
   *
   * @param subscriptionId EventSub subscription ID to delete.
   */
  async deleteEventSubSubscription(subscriptionId: string): Promise<void> {
    await this.requestEmpty(
      `eventsub/subscriptions?id=${encodeURIComponent(subscriptionId)}`,
      {
        method: 'DELETE',
      },
    );
  }
}
