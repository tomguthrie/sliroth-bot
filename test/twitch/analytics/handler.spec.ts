import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import migrationSql from '../../../src/db/twitch-analytics/migrations/20260815112814_damp_praxagora/migration.sql';

const migrations = [
  {
    name: '20260815112814_damp_praxagora',
    queries: migrationSql
      .split('--> statement-breakpoint')
      .map((query) => query.trim())
      .filter((query) => query.length > 0),
  },
];
const SCOPES = [
  'bits:read',
  'channel:bot',
  'channel:read:redemptions',
  'channel:read:subscriptions',
  'moderator:read:followers',
  'user:bot',
  'user:read:chat',
];
const EventSubRequest = z.object({
  type: z.string(),
  version: z.string(),
  condition: z.record(z.string(), z.string()),
  transport: z.object({ callback: z.string() }),
});

beforeAll(async () => {
  await applyD1Migrations(env.TWITCH_ANALYTICS_DB, migrations);
});

describe('Twitch analytics authorization', () => {
  it('protects setup with the configured bearer secret', async () => {
    const response = await exports.default.fetch(
      'https://bot.example.com/twitch/analytics/setup',
    );
    expect(response.status).toBe(401);
  });

  it('authorizes only the configured broadcaster and enables capture', async () => {
    const setup = await exports.default.fetch(
      'https://bot.example.com/twitch/analytics/setup',
      {
        headers: {
          Authorization: `Bearer ${env.TWITCH_ANALYTICS_SETUP_SECRET}`,
        },
        redirect: 'manual',
      },
    );
    expect(setup.status).toBe(302);
    const twitchAuthorization = new URL(setup.headers.get('location') ?? '');
    expect(twitchAuthorization.origin).toBe('https://id.twitch.tv');
    expect(twitchAuthorization.searchParams.get('scope')?.split(' ')).toEqual(
      SCOPES,
    );
    const state = twitchAuthorization.searchParams.get('state');
    expect(state).not.toBeNull();

    let eventSubNumber = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/oauth2/token') {
        const body = new URLSearchParams(
          new TextDecoder().decode(await request.arrayBuffer()),
        );
        if (body.get('grant_type') === 'authorization_code') {
          return Response.json({
            access_token: 'user-access-token',
            refresh_token: 'user-refresh-token',
            expires_in: 3600,
            scope: SCOPES,
            token_type: 'bearer',
          });
        }
        return Response.json({
          access_token: 'app-access-token',
          expires_in: 3600,
          token_type: 'bearer',
        });
      }
      if (url.pathname === '/oauth2/validate') {
        return Response.json({
          client_id: env.TWITCH_CLIENT_ID,
          login: 'sliroth',
          scopes: SCOPES,
          user_id: env.TWITCH_ANALYTICS_CHANNEL_ID,
          expires_in: 3600,
        });
      }
      if (url.pathname === '/helix/users') {
        return Response.json({
          data: [
            {
              id: env.TWITCH_ANALYTICS_CHANNEL_ID,
              login: 'sliroth',
              display_name: 'Sliroth',
              profile_image_url: 'https://example.com/profile.png',
              offline_image_url: '',
            },
          ],
        });
      }
      if (
        url.pathname === '/helix/eventsub/subscriptions' &&
        request.method === 'POST'
      ) {
        const body = EventSubRequest.parse(await request.json());
        eventSubNumber += 1;
        return Response.json({
          data: [
            {
              id: `analytics-subscription-${eventSubNumber}`,
              status: 'webhook_callback_verification_pending',
              type: body.type,
              version: body.version,
              condition: body.condition,
              transport: {
                method: 'webhook',
                callback: body.transport.callback,
              },
              created_at: '2026-08-15T12:00:00Z',
              cost: 0,
            },
          ],
        });
      }
      throw new Error(
        `Unexpected request: ${request.method} ${url.toString()}`,
      );
    });

    const callback = new URL('/twitch/analytics/callback', env.PUBLIC_BASE_URL);
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', state ?? '');
    const response = await exports.default.fetch(callback);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Twitch analytics enabled');
    expect(eventSubNumber).toBe(8);
    const channel = await env.TWITCH_ANALYTICS_DB.prepare(
      'SELECT channel_id, login FROM analytics_channels WHERE channel_id = ?',
    )
      .bind(env.TWITCH_ANALYTICS_CHANNEL_ID)
      .first<{ channel_id: string; login: string }>();
    expect(channel).toEqual({
      channel_id: env.TWITCH_ANALYTICS_CHANNEL_ID,
      login: 'sliroth',
    });
  });
});
