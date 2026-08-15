import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscordInteraction } from '../../src/discord/interaction';
import { twitchDiscordCommand } from '../../src/twitch/discord-command';

const mocks = vi.hoisted(() => ({
  resolveTwitchChannel: vi.fn(),
  listChannelTwitchSubscriptions: vi.fn(),
  listGuildTwitchSubscriptions: vi.fn(),
}));

vi.mock('../../src/twitch/channel', () => ({
  resolveTwitchChannel: mocks.resolveTwitchChannel,
}));

vi.mock('../../src/twitch/subscription/index', () => ({
  listChannelTwitchSubscriptions: mocks.listChannelTwitchSubscriptions,
  listGuildTwitchSubscriptions: mocks.listGuildTwitchSubscriptions,
}));

const APPLICATION_ID = '123456789012345678';
const GUILD_ID = '234567890123456789';
const CHANNEL_ID = '345678901234567890';
const OTHER_CHANNEL_ID = '456789012345678901';
const BROADCASTER_ID = '567890123456789012';
const handleTwitchCommand = twitchDiscordCommand.handle;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listChannelTwitchSubscriptions.mockResolvedValue([]);
  mocks.listGuildTwitchSubscriptions.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/twitch command', () => {
  it('requires Embed Links permission when adding', async () => {
    const response = await handleTwitchCommand(
      interaction('add', [{ type: 3, name: 'twitch', value: 'sliroth' }], {
        appPermissions: '3072',
      }),
      env,
      createExecutionContext(),
    );

    await expect(content(response)).resolves.toBe(
      'I need Embed Links permission in this channel.',
    );
  });

  it('adds a broadcaster through a deferred response', async () => {
    const broadcaster = {
      id: BROADCASTER_ID,
      login: 'sliroth',
      displayName: 'Sliroth',
      profileImageUrl: 'https://example.com/profile.png',
      offlineImageUrl: 'https://example.com/offline.png',
    };
    mocks.resolveTwitchChannel.mockResolvedValue(broadcaster);
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(BROADCASTER_ID);
    const addSubscriber = vi
      .spyOn(subscription, 'addSubscriber')
      .mockResolvedValue(undefined);
    vi.spyOn(env.TWITCH_SUBSCRIPTIONS, 'getByName').mockReturnValue(
      subscription,
    );
    const requests = mockInteractionEdits();
    const ctx = createExecutionContext();

    const response = await handleTwitchCommand(
      interaction(
        'add',
        [
          { type: 3, name: 'twitch', value: 'sliroth' },
          { type: 3, name: 'message', value: 'Sliroth is live!' },
          { type: 3, name: 'offline', value: 'Sliroth was live.' },
          { type: 3, name: 'ping', value: 'here' },
        ],
        {
          appPermissions: '150528',
        },
      ),
      env,
      ctx,
    );

    await expect(response.json()).resolves.toEqual({
      type: 5,
      data: { flags: 64 },
    });
    await waitOnExecutionContext(ctx);
    expect(addSubscriber).toHaveBeenCalledWith(broadcaster, {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      message: 'Sliroth is live!',
      offline: 'Sliroth was live.',
      ping: 'here',
    });
    await expect(requests[0]?.json()).resolves.toEqual({
      content: `Streams from **Sliroth** will be posted in <#${CHANNEL_ID}> and mention @here.`,
      allowed_mentions: { parse: [] },
    });
  });

  it('removes subscriptions without checking delivery permissions', async () => {
    mocks.listChannelTwitchSubscriptions.mockResolvedValue([BROADCASTER_ID]);
    const subscription = env.TWITCH_SUBSCRIPTIONS.getByName(BROADCASTER_ID);
    const removeSubscriber = vi
      .spyOn(subscription, 'removeSubscriber')
      .mockResolvedValue(true);
    vi.spyOn(env.TWITCH_SUBSCRIPTIONS, 'getByName').mockReturnValue(
      subscription,
    );
    mockInteractionEdits();
    const ctx = createExecutionContext();

    const response = await handleTwitchCommand(
      interaction('remove', [], { appPermissions: '0', channelType: 2 }),
      env,
      ctx,
    );

    await expect(response.json()).resolves.toMatchObject({ type: 5 });
    await waitOnExecutionContext(ctx);
    expect(removeSubscriber).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it('lists plain broadcaster names with the current channel first', async () => {
    mocks.listGuildTwitchSubscriptions.mockResolvedValue([
      {
        discordChannelId: OTHER_CHANNEL_ID,
        twitchBroadcasterId: '1',
        twitchBroadcasterLogin: 'zulu',
        twitchBroadcasterDisplayName: 'Zulu',
      },
      {
        discordChannelId: CHANNEL_ID,
        twitchBroadcasterId: BROADCASTER_ID,
        twitchBroadcasterLogin: 'sliroth',
        twitchBroadcasterDisplayName: 'Sliroth',
      },
    ]);

    const response = await handleTwitchCommand(
      interaction('list'),
      env,
      createExecutionContext(),
    );
    const list = await content(response);

    expect(list).toBe(
      `**Twitch notifications in this server**\nSliroth → <#${CHANNEL_ID}>*\nZulu → <#${OTHER_CHANNEL_ID}>`,
    );
    expect(list).not.toContain('https://');
  });

  it('rejects add when the bot cannot send messages', async () => {
    const response = await handleTwitchCommand(
      interaction('add', [{ type: 3, name: 'twitch', value: 'sliroth' }], {
        appPermissions: '1024',
      }),
      env,
      createExecutionContext(),
    );

    await expect(content(response)).resolves.toBe(
      'I need View Channel and Send Messages permissions in this channel.',
    );
  });
});

function interaction(
  command: 'add' | 'list' | 'remove',
  options: unknown[] = [],
  overrides: {
    appPermissions?: string;
    channelType?: number;
  } = {},
): DiscordInteraction {
  return {
    type: 2,
    application_id: APPLICATION_ID,
    token: 'interaction-token',
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    channel: { type: overrides.channelType ?? 0 },
    app_permissions: overrides.appPermissions ?? '19456',
    member: { permissions: '32' },
    data: {
      name: 'twitch',
      options: [
        {
          type: 1,
          name: command,
          ...(options.length === 0 ? {} : { options }),
        },
      ],
    },
  };
}

function mockInteractionEdits(): Request[] {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  return requests;
}

async function content(response: Response): Promise<string> {
  const body = await response.json<{ data: { content: string } }>();
  return body.data.content;
}
