import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('TwitchSubscription analytics schema', () => {
  it('keeps broadcaster-local analytics state free of channel IDs', async () => {
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(
      crypto.randomUUID(),
    );

    const schema = await runInDurableObject(
      subscription,
      (_instance, state) => {
        const tableColumns = (table: string) =>
          state.storage.sql
            .exec<{ name: string }>(`PRAGMA table_info('${table}')`)
            .toArray()
            .map(({ name }) => name);

        return {
          authorization: tableColumns('analytics_authorization'),
          runtime: tableColumns('analytics_runtime'),
          oauthStates: tableColumns('analytics_oauth_states'),
          finalizers: tableColumns('analytics_pending_finalizers'),
          eventSub: tableColumns('eventsub_subscriptions'),
        };
      },
    );

    expect(schema.authorization).not.toContain('channel_id');
    expect(schema.runtime).not.toContain('channel_id');
    expect(schema.oauthStates).not.toContain('channel_id');
    expect(schema.finalizers).not.toContain('channel_id');
    expect(schema.authorization).toContain('singleton');
    expect(schema.runtime).toContain('singleton');
    expect(schema.eventSub).toEqual([
      'subscription_key',
      'type',
      'version',
      'condition_json',
      'subscription_id',
    ]);
  });
});
