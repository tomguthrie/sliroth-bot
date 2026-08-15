import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import migrationSql from '../../../src/db/twitch-analytics/migrations/20260815112814_damp_praxagora/migration.sql';
import { analyticsRuntime } from '../../../src/db/twitch-subscription/schema';

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

    const activeStreamId = `stream-${crypto.randomUUID()}`;
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      env.TWITCH_ANALYTICS_CHANNEL_ID,
    );
    await runInDurableObject(subscription, async (_instance, state) => {
      const database = drizzle(state.storage);
      await database.insert(analyticsRuntime).values({
        singleton: 1,
        status: 'reauthorization_required',
        enabledAt: new Date(),
        activeStreamId,
      });
    });

    const eventSubTypes: string[] = [];
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
      if (url.pathname === '/helix/streams') {
        return Response.json({
          data: [
            {
              id: activeStreamId,
              user_id: env.TWITCH_ANALYTICS_CHANNEL_ID,
              user_login: 'sliroth',
              user_name: 'Sliroth',
              game_id: 'game-1',
              game_name: 'A Category',
              title: 'Reauthorization test',
              viewer_count: 4,
              started_at: '2026-08-16T08:00:00Z',
              thumbnail_url: 'https://example.com/preview.jpg',
            },
          ],
        });
      }
      if (url.pathname === '/helix/channels/followers') {
        return Response.json({ data: [], total: 119 });
      }
      if (url.pathname === '/helix/subscriptions') {
        return Response.json({ data: [], total: 1 });
      }
      if (
        url.pathname === '/helix/eventsub/subscriptions' &&
        request.method === 'POST'
      ) {
        const body = EventSubRequest.parse(await request.json());
        eventSubTypes.push(body.type);
        return Response.json({
          data: [
            {
              id: `analytics-subscription-${eventSubTypes.length}`,
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
    expect(eventSubTypes).toEqual([
      'channel.update',
      'stream.online',
      'stream.offline',
      'channel.follow',
      'channel.subscribe',
      'channel.subscription.gift',
      'channel.cheer',
      'channel.channel_points_custom_reward_redemption.add',
      'channel.chat.message',
      'channel.raid',
      'channel.raid',
    ]);
    const channel = await env.TWITCH_ANALYTICS_DB.prepare(
      'SELECT channel_id, login FROM analytics_channels WHERE channel_id = ?',
    )
      .bind(env.TWITCH_ANALYTICS_CHANNEL_ID)
      .first<{ channel_id: string; login: string }>();
    expect(channel).toEqual({
      channel_id: env.TWITCH_ANALYTICS_CHANNEL_ID,
      login: 'sliroth',
    });
    await vi.waitFor(async () => {
      const resumed = await runInDurableObject(
        subscription,
        async (_instance, state) => {
          const database = drizzle(state.storage);
          const [runtime] = await database
            .select()
            .from(analyticsRuntime)
            .limit(1);
          return {
            runtime,
            alarm: await state.storage.getAlarm(),
          };
        },
      );
      expect(resumed.runtime).toMatchObject({
        status: 'active',
        activeStreamId,
      });
      expect(resumed.alarm).not.toBeNull();
    });
  });
});
