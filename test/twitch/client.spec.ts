import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import {
  TwitchApiClient,
  TwitchApiError,
  type TwitchTokenGetter,
} from '../../src/twitch/client';

function tokenGetter(...tokens: string[]) {
  return vi.fn((_env: Env) =>
    Promise.resolve(tokens.shift() ?? 'token'),
  ) satisfies TwitchTokenGetter;
}

function requestUrl(input: RequestInfo | URL | undefined): string | undefined {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}

const USER = {
  id: '123',
  login: 'sliroth',
  display_name: 'Sliroth',
  profile_image_url: 'https://example.com/profile.png',
  offline_image_url: 'https://example.com/offline.png',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TwitchApiClient', () => {
  it('authenticates Helix requests and parses channel data', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: [USER] }));
    const client = new TwitchApiClient(env, tokenGetter('access-token'));

    await expect(client.getUserByLogin('sliroth')).resolves.toEqual({
      id: '123',
      login: 'sliroth',
      displayName: 'Sliroth',
      profileImageUrl: 'https://example.com/profile.png',
      offlineImageUrl: 'https://example.com/offline.png',
    });

    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl(input)).toBe(
      'https://api.twitch.tv/helix/users?login=sliroth',
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('client-id')).toBe(env.TWITCH_CLIENT_ID);
  });

  it('rejects an invalid Helix response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [{ ...USER, display_name: 123 }] }),
    );
    const client = new TwitchApiClient(env, tokenGetter('access-token'));

    await expect(client.getUserById('123')).rejects.toBeInstanceOf(z.ZodError);
  });

  it('parses streams, games, and archive videos', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
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
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: 'game-1',
              name: 'Gothic 1 Remake',
              box_art_url: 'https://example.com/{width}x{height}.jpg',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: 'video-1',
              stream_id: 'stream-1',
              user_id: '123',
              user_login: 'sliroth',
              user_name: 'Sliroth',
              title: 'Jelly Armed Man',
              created_at: '2026-06-06T19:32:00Z',
              published_at: '2026-06-06T19:32:00Z',
              url: 'https://twitch.tv/videos/video-1',
              thumbnail_url: 'https://example.com/video.jpg',
              type: 'archive',
              duration: '6h23m8s',
            },
          ],
        }),
      );
    const client = new TwitchApiClient(env, tokenGetter());

    await expect(client.getStreamByUserId('123')).resolves.toMatchObject({
      id: 'stream-1',
      gameName: 'Gothic 1 Remake',
      viewerCount: 3,
    });
    await expect(client.getGameById('game-1')).resolves.toEqual({
      id: 'game-1',
      name: 'Gothic 1 Remake',
      boxArtUrl: 'https://example.com/{width}x{height}.jpg',
    });
    await expect(client.getArchiveVideosByUserId('123')).resolves.toEqual([
      expect.objectContaining({
        id: 'video-1',
        streamId: 'stream-1',
        type: 'archive',
        duration: '6h23m8s',
      }),
    ]);
  });

  it('invalidates and retries once after a Helix 401', async () => {
    await env.TOKEN_STORE.put('twitch', 'old');
    const getToken = tokenGetter('old', 'new');
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [USER] }));
    const client = new TwitchApiClient(env, getToken);

    await expect(client.getUserById('123')).resolves.toMatchObject({
      id: '123',
    });
    expect(getToken).toHaveBeenCalledTimes(2);
    await expect(env.TOKEN_STORE.get('twitch')).resolves.toBeNull();
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization'),
    ).toBe('Bearer new');
  });

  it('surfaces Twitch rate-limit reset time', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { message: 'Too Many Requests' },
        { status: 429, headers: { 'ratelimit-reset': '1786233600' } },
      ),
    );
    const client = new TwitchApiClient(env, tokenGetter());

    const error = await client
      .getUserById('123')
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TwitchApiError);
    expect(error).toMatchObject({ status: 429, retryAtMs: 1_786_233_600_000 });
  });

  it('creates, reads, and deletes EventSub subscriptions', async () => {
    const subscription = {
      id: 'eventsub-1',
      status: 'webhook_callback_verification_pending',
      type: 'stream.online',
      version: '1',
      condition: { broadcaster_user_id: '123' },
      created_at: '2026-08-08T12:00:00Z',
      transport: {
        method: 'webhook',
        callback: 'https://bot.example.com/twitch',
      },
      cost: 0,
    };
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [subscription] }))
      .mockResolvedValueOnce(Response.json({ data: [subscription] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new TwitchApiClient(env, tokenGetter());

    await expect(
      client.createEventSubSubscription({
        type: 'stream.online',
        version: '1',
        condition: { broadcaster_user_id: '123' },
        callback: 'https://bot.example.com/twitch',
        secret: 'webhook-secret',
      }),
    ).resolves.toMatchObject({
      id: 'eventsub-1',
      createdAt: '2026-08-08T12:00:00Z',
    });
    await expect(
      client.getEventSubSubscriptionById('eventsub-1'),
    ).resolves.toMatchObject({
      id: 'eventsub-1',
      createdAt: '2026-08-08T12:00:00Z',
    });
    await client.deleteEventSubSubscription('eventsub-1');

    const createBody = fetcher.mock.calls[0]?.[1]?.body;
    expect(
      typeof createBody === 'string' ? JSON.parse(createBody) : createBody,
    ).toEqual({
      type: 'stream.online',
      version: '1',
      condition: { broadcaster_user_id: '123' },
      transport: {
        method: 'webhook',
        callback: 'https://bot.example.com/twitch',
        secret: 'webhook-secret',
      },
    });
    expect(requestUrl(fetcher.mock.calls[1]?.[0])).toContain(
      'subscription_id=eventsub-1',
    );
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });
});
