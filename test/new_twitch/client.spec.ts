import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { getAccessToken } from '../../src/new_twitch/auth';
import { TwitchClient } from '../../src/new_twitch/client';

vi.mock('../../src/new_twitch/auth', () => ({
  getAccessToken: vi.fn(),
}));

const BROADCASTER_ID = '123';
const LOGIN = 'sliroth';
const GAME_ID = 'game-456';

const USER = {
  id: '123',
  login: 'sliroth',
  display_name: 'Sliroth',
  profile_image_url: 'https://example.com/profile.png',
  offline_image_url: 'https://example.com/offline.png',
};

const STREAM = {
  id: 'stream-1',
  user_id: '123',
  user_login: 'sliroth',
  user_name: 'Sliroth',
  game_id: 'game-1',
  game_name: 'Gothic 1 Remake',
  title: 'Jelly Armed Man',
  viewer_count: 3,
  started_at: '2026-06-06T19:32:00Z',
  thumbnail_url: 'https://example.com/{width}x{height}.jpg',
};

const GAME = {
  id: 'game-1',
  name: 'Gothic 1 Remake',
  box_art_url: 'https://example.com/{width}x{height}.jpg',
};

function requestUrl(input: RequestInfo | URL | undefined): string | undefined {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAccessToken).mockResolvedValue('access-token');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TwitchClient GET methods', () => {
  it('gets a complete user by ID with an authenticated request', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: [USER] }));
    const client = new TwitchClient(env);

    await expect(client.getUserById(BROADCASTER_ID)).resolves.toEqual({
      id: '123',
      login: 'sliroth',
      displayName: 'Sliroth',
      profileImageUrl: 'https://example.com/profile.png',
      offlineImageUrl: 'https://example.com/offline.png',
    });

    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(getAccessToken).toHaveBeenCalledWith(env);
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl(input)).toBe('https://api.twitch.tv/helix/users?id=123');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('client-id')).toBe(env.TWITCH_CLIENT_ID);
  });

  it('gets a complete user by login and returns undefined for no match', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [USER] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const client = new TwitchClient(env);

    await expect(client.getUserByLogin(LOGIN)).resolves.toEqual({
      id: '123',
      login: 'sliroth',
      displayName: 'Sliroth',
      profileImageUrl: 'https://example.com/profile.png',
      offlineImageUrl: 'https://example.com/offline.png',
    });
    await expect(client.getUserByLogin('missing')).resolves.toBeUndefined();

    expect(requestUrl(fetcher.mock.calls[0]?.[0])).toBe(
      'https://api.twitch.tv/helix/users?login=sliroth',
    );
  });

  it('gets and transforms a complete stream by broadcaster ID', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: [STREAM] }));
    const client = new TwitchClient(env);

    await expect(client.getStream(BROADCASTER_ID)).resolves.toEqual({
      id: 'stream-1',
      broadcasterId: '123',
      broadcasterLogin: 'sliroth',
      broadcasterName: 'Sliroth',
      gameId: 'game-1',
      gameName: 'Gothic 1 Remake',
      title: 'Jelly Armed Man',
      viewerCount: 3,
      startedAt: new Date('2026-06-06T19:32:00Z'),
      thumbnailUrl: 'https://example.com/{width}x{height}.jpg',
    });
    expect(requestUrl(fetcher.mock.calls[0]?.[0])).toBe(
      'https://api.twitch.tv/helix/streams?user_id=123',
    );
  });

  it('returns undefined when a broadcaster has no live stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [] }),
    );

    await expect(
      new TwitchClient(env).getStream('offline'),
    ).resolves.toBeUndefined();
  });

  it('gets and transforms a complete game by ID', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: [GAME] }));
    const client = new TwitchClient(env);

    await expect(client.getGame(GAME_ID)).resolves.toEqual({
      id: 'game-1',
      name: 'Gothic 1 Remake',
      boxArtUrl: 'https://example.com/{width}x{height}.jpg',
    });
    expect(requestUrl(fetcher.mock.calls[0]?.[0])).toBe(
      'https://api.twitch.tv/helix/games?id=game-456',
    );
  });

  it('rejects malformed Helix data instead of returning a partial model', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [{ ...USER, display_name: 123 }] }),
    );

    await expect(
      new TwitchClient(env).getUserById('123'),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('reuses one access token across GET requests from the same client', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [USER] }))
      .mockResolvedValueOnce(Response.json({ data: [GAME] }));
    const client = new TwitchClient(env);

    await client.getUserById('123');
    await client.getGame('game-1');

    expect(getAccessToken).toHaveBeenCalledOnce();
  });

  it('includes Twitch error details and rate-limit reset time', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { message: 'Too Many Requests' },
        { status: 429, headers: { 'ratelimit-reset': '1786233600' } },
      ),
    );

    const error = await new TwitchClient(env)
      .getUserById('123')
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Twitch API returned HTTP 429: Too Many Requests',
      status: 429,
      retryAtMs: 1_786_233_600_000,
    });
  });

  it('refreshes its token and retries once after a 401', async () => {
    vi.mocked(getAccessToken)
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('fresh-token');
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [USER] }));
    const client = new TwitchClient(env);

    await expect(client.getUserById('123')).resolves.toMatchObject({
      id: '123',
    });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization'),
    ).toBe('Bearer fresh-token');
  });

  it('does not retry more than once after repeated 401 responses', async () => {
    vi.mocked(getAccessToken)
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('fresh-token');

    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(
      new TwitchClient(env).getUserById('123'),
    ).rejects.toMatchObject({
      status: 401,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('falls back to HTTP status text when Twitch error JSON is malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    await expect(
      new TwitchClient(env).getUserById('123'),
    ).rejects.toMatchObject({
      message: 'Twitch API returned HTTP 500: Internal Server Error',
      status: 500,
    });
  });

  it('ignores an invalid rate-limit reset header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { message: 'Too Many Requests' },
        {
          status: 429,
          headers: {
            'ratelimit-reset': 'invalid',
          },
        },
      ),
    );

    const error = await new TwitchClient(env)
      .getUserById('123')
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      status: 429,
      retryAtMs: undefined,
    });
  });
});

describe('TwitchClient EventSub methods', () => {
  const SUBSCRIPTION = {
    id: 'sub-123',
    status: 'webhook_callback_verification_pending',
    type: 'stream.online',
    version: '1',
    condition: {
      broadcaster_user_id: BROADCASTER_ID,
    },
    transport: {
      method: 'webhook',
      callback: 'https://example.com/twitch/eventsub',
    },
    created_at: '2026-08-13T12:00:00Z',
    cost: 0,
  };

  it('creates an EventSub subscription with POST', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: [SUBSCRIPTION] }));

    const client = new TwitchClient(env);

    await expect(
      client.createEventSubSubscription({
        type: 'stream.online',
        version: '1',
        condition: {
          broadcaster_user_id: BROADCASTER_ID,
        },
        transport: {
          method: 'webhook',
          callback: 'https://example.com/twitch/eventsub',
          secret: 'secret',
        },
      }),
    ).resolves.toMatchObject({
      id: 'sub-123',
      type: 'stream.online',
      version: '1',
    });

    const [input, init] = fetcher.mock.calls[0] ?? [];

    expect(requestUrl(input)).toBe(
      'https://api.twitch.tv/helix/eventsub/subscriptions',
    );

    expect(init?.method).toBe('POST');

    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('client-id')).toBe(env.TWITCH_CLIENT_ID);

    const body = init?.body;

    if (typeof body !== 'string') {
      throw new Error('Expected request body to be a string');
    }

    expect(JSON.parse(body)).toEqual({
      type: 'stream.online',
      version: '1',
      condition: {
        broadcaster_user_id: BROADCASTER_ID,
      },
      transport: {
        method: 'webhook',
        callback: 'https://example.com/twitch/eventsub',
        secret: 'secret',
      },
    });
  });

  it('gets an EventSub subscription by ID', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: [SUBSCRIPTION] }));

    const client = new TwitchClient(env);

    await expect(
      client.getEventSubSubscription('sub-123'),
    ).resolves.toMatchObject({
      id: 'sub-123',
      type: 'stream.online',
      version: '1',
    });

    expect(requestUrl(fetcher.mock.calls[0]?.[0])).toBe(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=sub-123',
    );
  });

  it('returns undefined when an EventSub subscription does not exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [] }),
    );

    await expect(
      new TwitchClient(env).getEventSubSubscription('missing'),
    ).resolves.toBeUndefined();
  });

  it('deletes an EventSub subscription with DELETE', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const client = new TwitchClient(env);

    await expect(
      client.deleteEventSubSubscription('sub-123'),
    ).resolves.toBeUndefined();

    const [input, init] = fetcher.mock.calls[0] ?? [];

    expect(requestUrl(input)).toBe(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=sub-123',
    );

    expect(init?.method).toBe('DELETE');

    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('client-id')).toBe(env.TWITCH_CLIENT_ID);
  });

  it('rejects when Twitch creates no EventSub subscription', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [] }),
    );

    await expect(
      new TwitchClient(env).createEventSubSubscription({
        type: 'stream.online',
        version: '1',
        condition: {
          broadcaster_user_id: BROADCASTER_ID,
        },
        transport: {
          method: 'webhook',
          callback: 'https://example.com/twitch/eventsub',
          secret: 'secret',
        },
      }),
    ).rejects.toThrow();
  });
});
