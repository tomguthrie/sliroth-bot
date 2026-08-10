import * as z from 'zod';

import { getValidToken, TWITCH_TOKEN_KEY } from './auth';
import {
  TwitchBroadcasterId,
  TwitchEventSubSubscriptionId,
  TwitchGameId,
  TwitchLogin,
  TwitchStreamId,
  TwitchTimestamp,
  TwitchVideoId,
} from './data';

export const TWITCH_API_BASE_URL = 'https://api.twitch.tv/helix/';

const NonBlankString = z.string().trim().min(1);

export const CreateTwitchEventSubSubscription = z.object({
  type: NonBlankString,
  version: NonBlankString,
  condition: z.record(z.string(), z.string()),
  callback: z.url({ protocol: /^https$/ }),
  secret: NonBlankString,
});

export type CreateTwitchEventSubSubscription = z.infer<
  typeof CreateTwitchEventSubSubscription
>;

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

export const TwitchUser = z.object({
  id: TwitchBroadcasterId,
  login: TwitchLogin,
  displayName: z.string().trim().min(1),
  profileImageUrl: z.string(),
  offlineImageUrl: z.string(),
});

export type TwitchUser = z.infer<typeof TwitchUser>;

const TwitchUserResponse = z
  .object({
    id: TwitchBroadcasterId,
    login: TwitchLogin,
    display_name: NonBlankString,
    profile_image_url: z.string(),
    offline_image_url: z.string(),
  })
  .transform(
    ({ id, login, display_name, profile_image_url, offline_image_url }) =>
      TwitchUser.parse({
        id,
        login,
        displayName: display_name,
        profileImageUrl: profile_image_url,
        offlineImageUrl: offline_image_url,
      }),
  );

export const TwitchStream = z
  .object({
    id: TwitchStreamId,
    user_id: TwitchBroadcasterId,
    user_login: TwitchLogin,
    user_name: NonBlankString,
    game_id: z.union([z.literal(''), TwitchGameId]),
    game_name: z.string(),
    title: z.string(),
    viewer_count: z.number(),
    started_at: TwitchTimestamp,
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
    id: TwitchGameId,
    name: NonBlankString,
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
    id: TwitchVideoId,
    stream_id: z.union([z.literal(''), TwitchStreamId]).nullable(),
    user_id: TwitchBroadcasterId,
    user_login: TwitchLogin,
    user_name: NonBlankString,
    title: z.string(),
    created_at: TwitchTimestamp,
    published_at: TwitchTimestamp,
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
    id: TwitchEventSubSubscriptionId,
    status: NonBlankString,
    type: NonBlankString,
    version: NonBlankString,
    condition: z.record(z.string(), z.string()),
    created_at: TwitchTimestamp,
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
const TwitchPageSize = z.int().min(1).max(100);

/** A typed client for the Twitch Helix endpoints used by the integration. */
export class TwitchApiClient {
  constructor(
    private readonly env: Env,
    private readonly getToken: typeof getValidToken = getValidToken,
  ) {}

  async getUserById(id: TwitchBroadcasterId): Promise<TwitchUser | undefined> {
    const response = await this.request('users', { id });
    const data = await parseTwitchApiResponse(response, TwitchUserResponse);
    return data[0];
  }

  async getUserByLogin(login: TwitchLogin): Promise<TwitchUser | undefined> {
    const response = await this.request('users', { login });
    const data = await parseTwitchApiResponse(response, TwitchUserResponse);
    return data[0];
  }

  async getStreamByUserId(
    userId: TwitchBroadcasterId,
  ): Promise<TwitchStream | undefined> {
    const response = await this.request('streams', { user_id: userId });
    const data = await parseTwitchApiResponse(response, TwitchStream);
    return data[0];
  }

  async getGameById(id: TwitchGameId): Promise<TwitchGame | undefined> {
    const response = await this.request('games', { id });
    const data = await parseTwitchApiResponse(response, TwitchGame);
    return data[0];
  }

  async getArchiveVideosByUserId(
    userId: TwitchBroadcasterId,
    first = 20,
  ): Promise<TwitchVod[]> {
    const pageSize = TwitchPageSize.parse(first);
    const response = await this.request('videos', {
      user_id: userId,
      type: 'archive',
      first: String(pageSize),
    });
    return parseTwitchApiResponse(response, TwitchVod);
  }

  async createEventSubSubscription(
    subscription: CreateTwitchEventSubSubscription,
  ): Promise<TwitchEventSubSubscription> {
    const validated = CreateTwitchEventSubSubscription.parse(subscription);
    const response = await this.request('eventsub/subscriptions', undefined, {
      method: 'POST',
      body: JSON.stringify({
        type: validated.type,
        version: validated.version,
        condition: validated.condition,
        transport: {
          method: 'webhook',
          callback: validated.callback,
          secret: validated.secret,
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
    id: TwitchEventSubSubscriptionId,
  ): Promise<TwitchEventSubSubscription | undefined> {
    const response = await this.request('eventsub/subscriptions', {
      subscription_id: id,
    });
    const data = await parseTwitchApiResponse(
      response,
      TwitchEventSubSubscription,
    );
    return data[0];
  }

  async deleteEventSubSubscription(
    id: TwitchEventSubSubscriptionId,
  ): Promise<void> {
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
