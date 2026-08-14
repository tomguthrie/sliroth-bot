import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { getAccessToken, refreshAccessToken } from '../../src/twitch/auth';

const ACCESS_TOKEN_KEY = 'twitch';
const ACCESS_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
let tokenRequestLogger: MockInstance;

function requestUrl(input: RequestInfo | URL | undefined): string | undefined {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}

function tokenResponse(accessToken: string, expiresIn = 3_600): Response {
  return Response.json({
    access_token: accessToken,
    expires_in: expiresIn,
  });
}

beforeEach(async () => {
  await env.TOKEN_STORE.delete(ACCESS_TOKEN_KEY);
  tokenRequestLogger = vi
    .spyOn(console, 'info')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getAccessToken', () => {
  it('returns a cached access token without requesting another one', async () => {
    await env.TOKEN_STORE.put(ACCESS_TOKEN_KEY, 'cached-token');
    const fetcher = vi.spyOn(globalThis, 'fetch');

    await expect(getAccessToken(env)).resolves.toBe('cached-token');
    expect(fetcher).not.toHaveBeenCalled();
    expect(tokenRequestLogger).not.toHaveBeenCalled();
  });

  it('requests and caches an access token until 80% of its expiry', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(tokenResponse('new-token'));
    const before = Math.floor(Date.now() / 1_000);

    await expect(getAccessToken(env)).resolves.toBe('new-token');
    await expect(env.TOKEN_STORE.get(ACCESS_TOKEN_KEY)).resolves.toBe(
      'new-token',
    );

    const key = (await env.TOKEN_STORE.list()).keys.find(
      ({ name }) => name === ACCESS_TOKEN_KEY,
    );
    expect(key?.expiration).toBeGreaterThanOrEqual(before + 2_879);
    expect(key?.expiration).toBeLessThanOrEqual(before + 2_881);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(tokenRequestLogger).toHaveBeenCalledOnce();
    expect(tokenRequestLogger).toHaveBeenCalledWith({
      event: 'twitch_token_requested',
    });
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl(input)).toBe(ACCESS_TOKEN_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(
      init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
    ).toBe(
      `client_id=${env.TWITCH_CLIENT_ID}&client_secret=${env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    );
  });

  it('requests a token when the cache read fails', async () => {
    vi.spyOn(env.TOKEN_STORE, 'get').mockRejectedValueOnce(
      new Error('KV read failed'),
    );
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(tokenResponse('new-token'));

    await expect(getAccessToken(env)).resolves.toBe('new-token');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns a fetched token when the cache write fails', async () => {
    vi.spyOn(env.TOKEN_STORE, 'put').mockRejectedValueOnce(
      new Error('KV write failed'),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse('new-token'));

    await expect(getAccessToken(env)).resolves.toBe('new-token');
  });

  it('rejects an unsuccessful token request without caching a value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    await expect(getAccessToken(env)).rejects.toThrow(
      'Failed to fetch access token: 401 Unauthorized',
    );
    await expect(env.TOKEN_STORE.get(ACCESS_TOKEN_KEY)).resolves.toBeNull();
  });

  it('rejects invalid JSON without caching a value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{not-json', { status: 200 }),
    );

    await expect(getAccessToken(env)).rejects.toThrow();
    await expect(env.TOKEN_STORE.get(ACCESS_TOKEN_KEY)).resolves.toBeNull();
  });

  it('rejects a malformed token response without caching a value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ access_token: 'new-token' }),
    );

    await expect(getAccessToken(env)).rejects.toThrow();
    await expect(env.TOKEN_STORE.get(ACCESS_TOKEN_KEY)).resolves.toBeNull();
  });
});

describe('refreshAccessToken', () => {
  it('replaces a cached access token without reading it again', async () => {
    await env.TOKEN_STORE.put(ACCESS_TOKEN_KEY, 'rejected-token');
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(tokenResponse('replacement-token'));

    await expect(refreshAccessToken(env)).resolves.toBe('replacement-token');
    await expect(env.TOKEN_STORE.get(ACCESS_TOKEN_KEY)).resolves.toBe(
      'replacement-token',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('requests a replacement when cache eviction fails', async () => {
    vi.spyOn(env.TOKEN_STORE, 'delete').mockRejectedValueOnce(
      new Error('KV delete failed'),
    );
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(tokenResponse('replacement-token'));

    await expect(refreshAccessToken(env)).resolves.toBe('replacement-token');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('leaves no rejected token cached when replacement fails', async () => {
    await env.TOKEN_STORE.put(ACCESS_TOKEN_KEY, 'rejected-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    await expect(refreshAccessToken(env)).rejects.toThrow(
      'Failed to fetch access token: 401 Unauthorized',
    );
    await expect(env.TOKEN_STORE.get(ACCESS_TOKEN_KEY)).resolves.toBeNull();
  });
});
