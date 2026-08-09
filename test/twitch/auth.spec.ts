import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getValidToken,
  TwitchAuthError,
  TWITCH_TOKEN_KEY,
  TWITCH_TOKEN_URL,
} from '../../src/twitch/auth';

function requestUrl(input: RequestInfo | URL | undefined): string | undefined {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}

function tokenResponse(accessToken: string, expiresIn = 3_600): Response {
  return Response.json({
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: 'bearer',
  });
}

beforeEach(async () => {
  await env.TOKEN_STORE.delete(TWITCH_TOKEN_KEY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getValidToken', () => {
  it('returns a token already stored in KV', async () => {
    await env.TOKEN_STORE.put(TWITCH_TOKEN_KEY, 'cached');
    const fetcher = vi.spyOn(globalThis, 'fetch');

    await expect(getValidToken(env)).resolves.toBe('cached');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requests and stores a token until 80% of its expiry', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(tokenResponse('new-token'));
    const before = Math.floor(Date.now() / 1000);

    await expect(getValidToken(env)).resolves.toBe('new-token');
    await expect(env.TOKEN_STORE.get(TWITCH_TOKEN_KEY)).resolves.toBe(
      'new-token',
    );

    const key = (await env.TOKEN_STORE.list()).keys.find(
      ({ name }) => name === TWITCH_TOKEN_KEY,
    );
    expect(key?.expiration).toBeGreaterThanOrEqual(before + 2_879);
    expect(key?.expiration).toBeLessThanOrEqual(before + 2_881);
    expect(fetcher).toHaveBeenCalledOnce();
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl(input)).toBe(TWITCH_TOKEN_URL);
    expect(init?.method).toBe('POST');
    expect(
      init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
    ).toBe(
      `client_id=${env.TWITCH_CLIENT_ID}&client_secret=${env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    );
  });

  it('replaces a cached token that cannot be used in a header', async () => {
    await env.TOKEN_STORE.put(TWITCH_TOKEN_KEY, 'invalid\ntoken');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse('new-token'));

    await expect(getValidToken(env)).resolves.toBe('new-token');
    await expect(env.TOKEN_STORE.get(TWITCH_TOKEN_KEY)).resolves.toBe(
      'new-token',
    );
  });

  it('rejects an unsuccessful token request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 401 }),
    );

    await expect(getValidToken(env)).rejects.toEqual(
      new TwitchAuthError('Twitch app access token returned HTTP 401'),
    );
  });

  it('rejects invalid JSON from the token endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{not-json', { status: 200 }),
    );

    await expect(getValidToken(env)).rejects.toThrow();
  });

  it('rejects an unusable token response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ access_token: '', expires_in: 3_600 }),
    );

    await expect(getValidToken(env)).rejects.toEqual(
      new TwitchAuthError('Twitch app access token response was unusable'),
    );
  });

  it('rejects a token that would expire before KV permits', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      tokenResponse('short-lived-token', 30),
    );

    await expect(getValidToken(env)).rejects.toEqual(
      new TwitchAuthError('Twitch app access token response was unusable'),
    );
  });
});
