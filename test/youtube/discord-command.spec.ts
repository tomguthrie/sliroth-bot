import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscordInteraction } from '../../src/discord/interaction';
import type { resolveYouTubeChannel } from '../../src/youtube/channel';
import { youtubeDiscordCommand } from '../../src/youtube/discord-command';
import type {
  listChannelYouTubeSubscriptions,
  listGuildYouTubeSubscriptions,
} from '../../src/youtube/subscription/index';

type ResolveYouTubeChannel = typeof resolveYouTubeChannel;
type ListChannelYouTubeSubscriptions = typeof listChannelYouTubeSubscriptions;
type ListGuildYouTubeSubscriptions = typeof listGuildYouTubeSubscriptions;

const mocks = vi.hoisted(() => ({
  resolveYouTubeChannel: vi.fn<ResolveYouTubeChannel>(),
  listChannelYouTubeSubscriptions: vi.fn<ListChannelYouTubeSubscriptions>(),
  listGuildYouTubeSubscriptions: vi.fn<ListGuildYouTubeSubscriptions>(),
}));

vi.mock('../../src/youtube/channel', () => ({
  resolveYouTubeChannel: mocks.resolveYouTubeChannel,
}));

vi.mock('../../src/youtube/subscription/index', () => ({
  listChannelYouTubeSubscriptions: mocks.listChannelYouTubeSubscriptions,
  listGuildYouTubeSubscriptions: mocks.listGuildYouTubeSubscriptions,
}));

const APPLICATION_ID = '123456789012345678';
const GUILD_ID = '234567890123456789';
const CHANNEL_ID = '345678901234567890';
const OTHER_CHANNEL_ID = '456789012345678901';
const ROLE_ID = '567890123456789012';
const YOUTUBE_CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const handleYouTubeCommand = youtubeDiscordCommand.handle;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listChannelYouTubeSubscriptions.mockResolvedValue([]);
  mocks.listGuildYouTubeSubscriptions.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/youtube command', () => {
  it('requires Manage Server permission', async () => {
    const response = await handleYouTubeCommand(
      interaction('list', [], { memberPermissions: '0' }),
      env,
      createExecutionContext(),
    );

    await expect(content(response)).resolves.toBe(
      'You need the Manage Server permission to use this command.',
    );
  });

  it('adds a channel through a deferred response', async () => {
    mocks.resolveYouTubeChannel.mockResolvedValue({
      id: YOUTUBE_CHANNEL_ID,
      title: 'Google Developers',
    });
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(YOUTUBE_CHANNEL_ID);
    const addSubscriber = vi.spyOn(subscription, 'addSubscriber').mockResolvedValue(undefined);
    vi.spyOn(env.YOUTUBE_SUBSCRIPTIONS, 'getByName').mockReturnValue(subscription);
    const requests = mockInteractionEdits();
    const ctx = createExecutionContext();

    const response = await handleYouTubeCommand(
      interaction(
        'add',
        [
          { type: 3, name: 'youtube', value: YOUTUBE_CHANNEL_ID },
          { type: 3, name: 'message', value: 'New upload' },
          { type: 8, name: 'role', value: ROLE_ID },
        ],
        {
          resolvedRoles: { [ROLE_ID]: { mentionable: true } },
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
    expect(addSubscriber).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      channelTitle: 'Google Developers',
      message: 'New upload',
      ping: ROLE_ID,
    });
    await expect(requests[0]?.json()).resolves.toEqual({
      content: `Uploads from **Google Developers** will be posted in <#${CHANNEL_ID}> and mention <@&${ROLE_ID}>.`,
      allowed_mentions: { parse: [] },
    });
  });

  it('removes subscriptions after the bot loses posting access', async () => {
    mocks.listChannelYouTubeSubscriptions.mockResolvedValue([YOUTUBE_CHANNEL_ID]);
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(YOUTUBE_CHANNEL_ID);
    const removeSubscriber = vi
      .spyOn(subscription, 'removeSubscriber')
      .mockResolvedValue(undefined);
    vi.spyOn(env.YOUTUBE_SUBSCRIPTIONS, 'getByName').mockReturnValue(subscription);
    mockInteractionEdits();
    const ctx = createExecutionContext();

    const response = await handleYouTubeCommand(
      interaction('remove', [], { appPermissions: '0', channelType: 2 }),
      env,
      ctx,
    );

    await expect(response.json()).resolves.toMatchObject({ type: 5 });
    await waitOnExecutionContext(ctx);
    expect(removeSubscriber).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it.each([undefined, false])('does not fetch status when status is %s', async (status) => {
    mocks.listGuildYouTubeSubscriptions.mockResolvedValue([
      {
        discordChannelId: CHANNEL_ID,
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        youtubeChannelTitle: 'Google Developers',
      },
    ]);
    const getByName = vi.spyOn(env.YOUTUBE_SUBSCRIPTIONS, 'getByName');
    const options = status === undefined ? [] : [{ type: 5, name: 'status', value: status }];
    const response = await handleYouTubeCommand(
      interaction('list', options),
      env,
      createExecutionContext(),
    );
    await expect(response.json()).resolves.toMatchObject({
      type: 4,
      data: {
        flags: 64,
        content: `**YouTube notifications in this server**\nGoogle Developers → <#${CHANNEL_ID}>*`,
      },
    });
    expect(getByName).not.toHaveBeenCalled();
  });

  it.each(['subscribed', 'subscribing', 'unsubscribing', null] as const)(
    'shows %s through a deferred response and looks up each YouTube channel once',
    async (status) => {
      mocks.listGuildYouTubeSubscriptions.mockResolvedValue(
        [CHANNEL_ID, OTHER_CHANNEL_ID].map((discordChannelId) => ({
          discordChannelId,
          youtubeChannelId: YOUTUBE_CHANNEL_ID,
          youtubeChannelTitle: 'Google Developers',
        })),
      );
      const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(YOUTUBE_CHANNEL_ID);
      const getStatus = vi
        .spyOn(subscription, 'getWebSubStatus')
        .mockResolvedValue({ status, nextAlarmAt: null, [Symbol.dispose]: vi.fn<() => void>() });
      const getByName = vi
        .spyOn(env.YOUTUBE_SUBSCRIPTIONS, 'getByName')
        .mockReturnValue(subscription);
      const requests = mockInteractionEdits();
      const ctx = createExecutionContext();
      const response = await handleYouTubeCommand(
        interaction('list', [{ type: 5, name: 'status', value: true }]),
        env,
        ctx,
      );
      await expect(response.json()).resolves.toEqual({ type: 5, data: { flags: 64 } });
      await waitOnExecutionContext(ctx);
      expect(getByName).toHaveBeenCalledExactlyOnceWith(YOUTUBE_CHANNEL_ID);
      expect(getStatus).toHaveBeenCalledOnce();
      await expect(requests[0]?.json()).resolves.toEqual({
        content: `**YouTube notifications in this server**\nGoogle Developers → <#${CHANNEL_ID}>* — WebSub: ${status ?? 'no state'} — no alarm scheduled\nGoogle Developers → <#${OTHER_CHANNEL_ID}> — WebSub: ${status ?? 'no state'} — no alarm scheduled`,
        allowed_mentions: { parse: [] },
      });
    },
  );

  it.each([
    ['subscribed', 'renewal'],
    ['subscribing', 'next retry'],
    ['unsubscribing', 'next retry'],
    [null, 'next alarm'],
  ] as const)('shows the scheduled alarm for %s as %s', async (status, label) => {
    mocks.listGuildYouTubeSubscriptions.mockResolvedValue([
      {
        discordChannelId: CHANNEL_ID,
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        youtubeChannelTitle: 'Google Developers',
      },
    ]);
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(YOUTUBE_CHANNEL_ID);
    vi.spyOn(subscription, 'getWebSubStatus').mockResolvedValue({
      status,
      nextAlarmAt: 1_800_000_000_123,
      [Symbol.dispose]: vi.fn<() => void>(),
    });
    vi.spyOn(env.YOUTUBE_SUBSCRIPTIONS, 'getByName').mockReturnValue(subscription);
    const requests = mockInteractionEdits();
    const ctx = createExecutionContext();
    await handleYouTubeCommand(
      interaction('list', [{ type: 5, name: 'status', value: true }]),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    await expect(requests[0]?.json()).resolves.toMatchObject({
      content: `**YouTube notifications in this server**\nGoogle Developers → <#${CHANNEL_ID}>* — WebSub: ${status ?? 'no state'} — ${label} <t:1800000000:R>`,
    });
  });

  it('preserves successful statuses when another lookup fails', async () => {
    const otherYouTubeChannelId = 'UCbbbbbbbbbbbbbbbbbbbbbb';
    mocks.listGuildYouTubeSubscriptions.mockResolvedValue(
      [YOUTUBE_CHANNEL_ID, otherYouTubeChannelId].map((youtubeChannelId) => ({
        discordChannelId: CHANNEL_ID,
        youtubeChannelId,
        youtubeChannelTitle: youtubeChannelId,
      })),
    );
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(YOUTUBE_CHANNEL_ID);
    const otherSubscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(otherYouTubeChannelId);
    vi.spyOn(subscription, 'getWebSubStatus').mockResolvedValue({
      status: 'subscribed',
      nextAlarmAt: null,
      [Symbol.dispose]: vi.fn<() => void>(),
    });
    vi.spyOn(otherSubscription, 'getWebSubStatus').mockRejectedValue(
      new Error('Storage unavailable'),
    );
    vi.spyOn(env.YOUTUBE_SUBSCRIPTIONS, 'getByName').mockImplementation((name) =>
      name === YOUTUBE_CHANNEL_ID ? subscription : otherSubscription,
    );
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const requests = mockInteractionEdits();
    const ctx = createExecutionContext();
    await handleYouTubeCommand(
      interaction('list', [{ type: 5, name: 'status', value: true }]),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = await requests[0]?.json<{ content: string }>();
    expect(body?.content).toContain('WebSub: subscribed');
    expect(body?.content).toContain('WebSub: unavailable');
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'youtube_websub_status_failed',
        youtubeChannelId: otherYouTubeChannelId,
        error: expect.objectContaining({ message: 'Storage unavailable' }),
      }),
    );
  });

  it('handles an empty status list without accessing Durable Objects', async () => {
    const getByName = vi.spyOn(env.YOUTUBE_SUBSCRIPTIONS, 'getByName');
    const requests = mockInteractionEdits();
    const ctx = createExecutionContext();
    await handleYouTubeCommand(
      interaction('list', [{ type: 5, name: 'status', value: true }]),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(getByName).not.toHaveBeenCalled();
    await expect(requests[0]?.json()).resolves.toMatchObject({
      content: 'No YouTube notifications are configured for this server.',
    });
  });

  it.each([
    [{ type: 5, name: 'status', value: 'true' }],
    [{ type: 3, name: 'status', value: true }],
    [{ type: 5, name: 'other', value: true }],
    [
      { type: 5, name: 'status', value: true },
      { type: 5, name: 'status', value: false },
    ],
  ])('rejects invalid list options: %j', async (...options) => {
    const response = await handleYouTubeCommand(
      interaction('list', options),
      env,
      createExecutionContext(),
    );
    await expect(content(response)).resolves.toBe('This interaction is not supported.');
    expect(mocks.listGuildYouTubeSubscriptions).not.toHaveBeenCalled();
  });

  it('renders a stable, preview-free, bounded list', async () => {
    mocks.listGuildYouTubeSubscriptions.mockResolvedValue([
      {
        discordChannelId: OTHER_CHANNEL_ID,
        youtubeChannelId: 'UCbbbbbbbbbbbbbbbbbbbbbb',
        youtubeChannelTitle: 'Zulu channel',
      },
      {
        discordChannelId: CHANNEL_ID,
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        youtubeChannelTitle: 'Current channel',
      },
      ...Array.from({ length: 80 }, (_, index) => ({
        discordChannelId: OTHER_CHANNEL_ID,
        youtubeChannelId: `UC${String(index).padStart(22, '0')}`,
        youtubeChannelTitle: `Long channel ${String(index).padStart(2, '0')} ${'x'.repeat(30)}`,
      })),
    ]);

    const response = await handleYouTubeCommand(interaction('list'), env, createExecutionContext());
    const list = await content(response);

    expect(list.length).toBeLessThanOrEqual(2_000);
    expect(list).toContain(`Current channel → <#${CHANNEL_ID}>*`);
    expect(list).not.toContain('https://');
    expect(list).toMatch(/…and \d+ more\.$/);
    expect(list.indexOf('Current channel')).toBeLessThan(list.indexOf('Long channel'));
  });

  it('rejects duplicate add options before starting background work', async () => {
    const ctx = createExecutionContext();
    const response = await handleYouTubeCommand(
      interaction('add', [
        { type: 3, name: 'youtube', value: YOUTUBE_CHANNEL_ID },
        { type: 3, name: 'youtube', value: YOUTUBE_CHANNEL_ID },
      ]),
      env,
      ctx,
    );

    await expect(content(response)).resolves.toBe('This interaction is not supported.');
    expect(mocks.resolveYouTubeChannel).not.toHaveBeenCalled();
  });

  it('reports a failed status list through the deferred response', async () => {
    mocks.listGuildYouTubeSubscriptions.mockRejectedValue(new Error('KV unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const requests = mockInteractionEdits();
    const ctx = createExecutionContext();
    const response = await handleYouTubeCommand(
      interaction('list', [{ type: 5, name: 'status', value: true }]),
      env,
      ctx,
    );
    await expect(response.json()).resolves.toMatchObject({ type: 5 });
    await waitOnExecutionContext(ctx);
    await expect(requests[0]?.json()).resolves.toMatchObject({
      content: 'YouTube notifications could not be loaded. Please try again.',
    });
  });

  it('logs provider and action context when listing fails', async () => {
    const error = new Error('KV unavailable');
    mocks.listGuildYouTubeSubscriptions.mockRejectedValue(error);
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleYouTubeCommand(interaction('list'), env, createExecutionContext());

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'discord_interaction_failed',
        provider: 'youtube',
        action: 'list',
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
      }),
    );
  });
});

function interaction(
  command: 'add' | 'list' | 'remove',
  options: unknown[] = [],
  overrides: {
    appPermissions?: string;
    memberPermissions?: string;
    channelType?: number;
    resolvedRoles?: Record<string, { mentionable?: boolean }>;
  } = {},
): DiscordInteraction {
  return {
    type: 2,
    application_id: APPLICATION_ID,
    token: 'interaction-token',
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    channel: { type: overrides.channelType ?? 0 },
    app_permissions: overrides.appPermissions ?? '134144',
    member: { permissions: overrides.memberPermissions ?? '32' },
    data: {
      name: 'youtube',
      options: [
        {
          type: 1,
          name: command,
          ...(options.length === 0 ? {} : { options }),
        },
      ],
      ...(overrides.resolvedRoles === undefined
        ? {}
        : { resolved: { roles: overrides.resolvedRoles } }),
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
