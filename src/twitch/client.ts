import * as z from 'zod';

import { getValidToken, TWITCH_TOKEN_KEY } from './auth';

export const TWITCH_API_BASE_URL = 'https://api.twitch.tv/helix/';

export interface CreateTwitchEventSubSubscription {
  type: string;
  version: string;
  condition: Record<string, string>;
  callback: string;
  secret: string;
}

/** Describes a non-success response from Helix. */
export class TwitchApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAtMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type TwitchTokenGetter = (env: Env) => Promise<string>;

export const TwitchUser = z
  .object({
    id: z.string(),
    login: z.string(),
    display_name: z.string(),
    profile_image_url: z.string(),
    offline_image_url: z.string(),
  })
  .transform(
    ({ id, login, display_name, profile_image_url, offline_image_url }) => ({
      id,
      login,
      displayName: display_name,
      profileImageUrl: profile_image_url,
      offlineImageUrl: offline_image_url,
    }),
  );

export type TwitchUser = z.infer<typeof TwitchUser>;

export const TwitchStream = z
  .object({
    id: z.string(),
    user_id: z.string(),
    user_login: z.string(),
    user_name: z.string(),
    game_id: z.string(),
    game_name: z.string(),
    title: z.string(),
    viewer_count: z.number(),
    started_at: z.string(),
    thumbnail_url: z.string(),
  })
  .transform((data) => ({
    id: data.id,
    userId: data.user_id,
    userLogin: data.user_login,
    userName: data.user_name,
    gameId: data.game_id,
    gameName: data.game_name,
    title: data.title,
    viewerCount: data.viewer_count,
    startedAt: data.started_at,
    thumbnailUrl: data.thumbnail_url,
  }));

export type TwitchStream = z.infer<typeof TwitchStream>;

export const TwitchGame = z
  .object({
    id: z.string(),
    name: z.string(),
    box_art_url: z.string(),
  })
  .transform(({ id, name, box_art_url: boxArtUrl }) => ({
    id,
    name,
    boxArtUrl,
  }));

export type TwitchGame = z.infer<typeof TwitchGame>;

export const TwitchVod = z
  .object({
    id: z.string(),
    stream_id: z.string().nullable(),
    user_id: z.string(),
    user_login: z.string(),
    user_name: z.string(),
    title: z.string(),
    created_at: z.string(),
    published_at: z.string(),
    url: z.string(),
    thumbnail_url: z.string(),
    type: z.enum(['archive', 'highlight', 'upload']),
    duration: z.string(),
  })
  .transform((data) => ({
    id: data.id,
    ...(data.stream_id === null || data.stream_id === ''
      ? {}
      : { streamId: data.stream_id }),
    userId: data.user_id,
    userLogin: data.user_login,
    userName: data.user_name,
    title: data.title,
    createdAt: data.created_at,
    publishedAt: data.published_at,
    url: data.url,
    thumbnailUrl: data.thumbnail_url,
    type: data.type,
    duration: data.duration,
  }));

export type TwitchVod = z.infer<typeof TwitchVod>;

export const TwitchEventSubSubscription = z
  .object({
    id: z.string(),
    status: z.string(),
    type: z.string(),
    version: z.string(),
    condition: z.record(z.string(), z.string()),
    created_at: z.string(),
    transport: z.object({
      method: z.string(),
      callback: z.string().optional(),
    }),
    cost: z.number(),
  })
  .transform((data) => ({
    id: data.id,
    status: data.status,
    type: data.type,
    version: data.version,
    condition: data.condition,
    createdAt: data.created_at,
    transport: data.transport,
    cost: data.cost,
  }));

export type TwitchEventSubSubscription = z.infer<
  typeof TwitchEventSubSubscription
>;

const TwitchApiErrorResponse = z.object({ message: z.string().optional() });

/** A typed client for the Twitch Helix endpoints used by the integration. */
export class TwitchApiClient {
  constructor(
    private readonly env: Env,
    private readonly getToken: TwitchTokenGetter = getValidToken,
  ) {}

  async getUserById(id: string): Promise<TwitchUser | undefined> {
    requireNonEmpty(id, 'Twitch user ID');
    const response = await this.request('users', { id });
    const data = await parseTwitchApiResponse(response, TwitchUser);
    return data[0];
  }

  async getUserByLogin(login: string): Promise<TwitchUser | undefined> {
    requireNonEmpty(login, 'Twitch user login');
    const response = await this.request('users', { login });
    const data = await parseTwitchApiResponse(response, TwitchUser);
    return data[0];
  }

  async getStreamByUserId(userId: string): Promise<TwitchStream | undefined> {
    requireNonEmpty(userId, 'Twitch user ID');
    const response = await this.request('streams', { user_id: userId });
    const data = await parseTwitchApiResponse(response, TwitchStream);
    return data[0];
  }

  async getGameById(id: string): Promise<TwitchGame | undefined> {
    requireNonEmpty(id, 'Twitch game ID');
    const response = await this.request('games', { id });
    const data = await parseTwitchApiResponse(response, TwitchGame);
    return data[0];
  }

  async getArchiveVideosByUserId(
    userId: string,
    first = 20,
  ): Promise<TwitchVod[]> {
    requireNonEmpty(userId, 'Twitch user ID');
    if (!Number.isSafeInteger(first) || first < 1 || first > 100) {
      throw new TwitchApiError('Twitch video page size must be from 1 to 100');
    }
    const response = await this.request('videos', {
      user_id: userId,
      type: 'archive',
      first: String(first),
    });
    return parseTwitchApiResponse(response, TwitchVod);
  }

  async createEventSubSubscription(
    subscription: CreateTwitchEventSubSubscription,
  ): Promise<TwitchEventSubSubscription> {
    validateSubscription(subscription);
    const response = await this.request('eventsub/subscriptions', undefined, {
      method: 'POST',
      body: JSON.stringify({
        type: subscription.type,
        version: subscription.version,
        condition: subscription.condition,
        transport: {
          method: 'webhook',
          callback: subscription.callback,
          secret: subscription.secret,
        },
      }),
    });
    const data = await parseTwitchApiResponse(
      response,
      TwitchEventSubSubscription,
    );
    const created = data[0];
    if (created === undefined) {
      throw new TwitchApiError(
        'Twitch EventSub create response did not contain a subscription',
      );
    }
    return created;
  }

  async getEventSubSubscriptionById(
    id: string,
  ): Promise<TwitchEventSubSubscription | undefined> {
    requireNonEmpty(id, 'Twitch EventSub subscription ID');
    const response = await this.request('eventsub/subscriptions', {
      subscription_id: id,
    });
    const data = await parseTwitchApiResponse(
      response,
      TwitchEventSubSubscription,
    );
    return data[0];
  }

  async deleteEventSubSubscription(id: string): Promise<void> {
    requireNonEmpty(id, 'Twitch EventSub subscription ID');
    await this.request('eventsub/subscriptions', { id }, { method: 'DELETE' });
  }

  private async request(
    path: string,
    query?: Record<string, string>,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(path, TWITCH_API_BASE_URL);
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, value);
    }

    let token = await this.getToken(this.env);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      headers.set('client-id', this.env.TWITCH_CLIENT_ID);
      if (init?.body !== undefined) {
        headers.set('content-type', 'application/json');
      }
      const response = await fetch(url, { ...init, headers });
      if (response.status === 401 && attempt === 0) {
        await cancelBody(response);
        await this.env.TOKEN_STORE.delete(TWITCH_TOKEN_KEY);
        token = await this.getToken(this.env);
        continue;
      }
      if (!response.ok) {
        throw await createApiError(response);
      }
      return response;
    }

    throw new TwitchApiError('Twitch API authentication failed', 401);
  }
}

/** Creates a Twitch client from the Worker's generated secret bindings. */
export function createTwitchApiClient(env: Env): TwitchApiClient {
  return new TwitchApiClient(env);
}

function validateSubscription(value: CreateTwitchEventSubSubscription): void {
  requireNonEmpty(value.type, 'Twitch EventSub type');
  requireNonEmpty(value.version, 'Twitch EventSub version');
  requireNonEmpty(value.callback, 'Twitch EventSub callback');
  requireNonEmpty(value.secret, 'Twitch EventSub secret');
}

function requireNonEmpty(value: string, description: string): void {
  if (value.trim() === '')
    throw new TwitchApiError(`${description} cannot be empty`);
}

async function createApiError(response: Response): Promise<TwitchApiError> {
  let detail: string;
  try {
    const result = TwitchApiErrorResponse.safeParse(await response.json());
    detail =
      result.success && result.data.message !== undefined
        ? `: ${result.data.message}`
        : '';
  } catch {
    detail = '';
  }
  const reset = response.headers.get('ratelimit-reset');
  const resetSeconds = reset === null ? Number.NaN : Number(reset);
  const retryAtMs =
    response.status === 429 && Number.isFinite(resetSeconds)
      ? resetSeconds * 1000
      : undefined;
  return new TwitchApiError(
    `Twitch API returned HTTP ${response.status}${detail}`,
    response.status,
    retryAtMs,
  );
}

async function parseTwitchApiResponse<T extends z.ZodType>(
  response: Response,
  dataSchema: T,
): Promise<z.output<T>[]> {
  const schema = z.object({ data: z.array(dataSchema) });
  return schema.parse(await response.json()).data;
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null) await response.body.cancel();
}
