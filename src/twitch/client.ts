import { getValidToken, TWITCH_TOKEN_KEY } from './auth';

export const TWITCH_API_BASE_URL = 'https://api.twitch.tv/helix/';

export interface TwitchUser {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  offlineImageUrl: string;
}

export interface TwitchStream {
  id: string;
  userId: string;
  userLogin: string;
  userName: string;
  gameId: string;
  gameName: string;
  title: string;
  viewerCount: number;
  startedAt: string;
  thumbnailUrl: string;
}

export interface TwitchGame {
  id: string;
  name: string;
  boxArtUrl: string;
}

export interface TwitchVod {
  id: string;
  streamId?: string;
  userId: string;
  userLogin: string;
  userName: string;
  title: string;
  createdAt: string;
  publishedAt: string;
  url: string;
  thumbnailUrl: string;
  type: 'archive' | 'highlight' | 'upload';
  duration: string;
}

export interface TwitchEventSubSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  createdAt: string;
  transport: {
    method: string;
    callback?: string;
  };
  cost: number;
}

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

interface TwitchApiResponse<T> {
  data: T[];
}

interface TwitchUserData {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  offline_image_url: string;
}

interface TwitchStreamData {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
}

interface TwitchGameData {
  id: string;
  name: string;
  box_art_url: string;
}

interface TwitchVodData {
  id: string;
  stream_id: string | null;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  created_at: string;
  published_at: string;
  url: string;
  thumbnail_url: string;
  type: 'archive' | 'highlight' | 'upload';
  duration: string;
}

interface TwitchEventSubSubscriptionData {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  created_at: string;
  transport: {
    method: string;
    callback?: string;
  };
  cost: number;
}

/** A typed client for the Twitch Helix endpoints used by the integration. */
export class TwitchApiClient {
  constructor(
    private readonly env: Env,
    private readonly getToken: TwitchTokenGetter = getValidToken,
  ) {}

  async getUserById(id: string): Promise<TwitchUser | undefined> {
    requireNonEmpty(id, 'Twitch user ID');
    const response = await this.request('users', { id });
    const { data } = await response.json<TwitchApiResponse<TwitchUserData>>();
    return data[0] === undefined ? undefined : mapUser(data[0]);
  }

  async getUserByLogin(login: string): Promise<TwitchUser | undefined> {
    requireNonEmpty(login, 'Twitch user login');
    const response = await this.request('users', { login });
    const { data } = await response.json<TwitchApiResponse<TwitchUserData>>();
    return data[0] === undefined ? undefined : mapUser(data[0]);
  }

  async getStreamByUserId(userId: string): Promise<TwitchStream | undefined> {
    requireNonEmpty(userId, 'Twitch user ID');
    const response = await this.request('streams', { user_id: userId });
    const { data } = await response.json<TwitchApiResponse<TwitchStreamData>>();
    return data[0] === undefined ? undefined : mapStream(data[0]);
  }

  async getGameById(id: string): Promise<TwitchGame | undefined> {
    requireNonEmpty(id, 'Twitch game ID');
    const response = await this.request('games', { id });
    const { data } = await response.json<TwitchApiResponse<TwitchGameData>>();
    return data[0] === undefined ? undefined : mapGame(data[0]);
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
    const { data } = await response.json<TwitchApiResponse<TwitchVodData>>();
    return data.map(mapVod);
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
    const { data } =
      await response.json<TwitchApiResponse<TwitchEventSubSubscriptionData>>();
    const created = data[0];
    if (created === undefined) {
      throw new TwitchApiError(
        'Twitch EventSub create response did not contain a subscription',
      );
    }
    return mapEventSubSubscription(created);
  }

  async getEventSubSubscriptionById(
    id: string,
  ): Promise<TwitchEventSubSubscription | undefined> {
    requireNonEmpty(id, 'Twitch EventSub subscription ID');
    const response = await this.request('eventsub/subscriptions', {
      subscription_id: id,
    });
    const { data } =
      await response.json<TwitchApiResponse<TwitchEventSubSubscriptionData>>();
    return data[0] === undefined ? undefined : mapEventSubSubscription(data[0]);
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

function mapUser(data: TwitchUserData): TwitchUser {
  return {
    id: data.id,
    login: data.login,
    displayName: data.display_name,
    profileImageUrl: data.profile_image_url,
    offlineImageUrl: data.offline_image_url,
  };
}

function mapStream(data: TwitchStreamData): TwitchStream {
  return {
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
  };
}

function mapGame(data: TwitchGameData): TwitchGame {
  return { id: data.id, name: data.name, boxArtUrl: data.box_art_url };
}

function mapVod(data: TwitchVodData): TwitchVod {
  return {
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
  };
}

function mapEventSubSubscription(
  data: TwitchEventSubSubscriptionData,
): TwitchEventSubSubscription {
  return {
    id: data.id,
    status: data.status,
    type: data.type,
    version: data.version,
    condition: data.condition,
    createdAt: data.created_at,
    transport: data.transport,
    cost: data.cost,
  };
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
    const { message } = await response.json<{ message?: string }>();
    detail = message === undefined ? '' : `: ${message}`;
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

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null) await response.body.cancel();
}
