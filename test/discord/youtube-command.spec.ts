import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleYouTubeCommand } from '../../src/discord/commands/youtube';
import type { DiscordInteraction } from '../../src/discord/commands/shared';

const mocks = vi.hoisted(() => ({
  resolveYouTubeChannel: vi.fn(),
  listChannelYouTubeSubscriptions: vi.fn(),
  listGuildYouTubeSubscriptions: vi.fn(),
}));

vi.mock('../../src/youtube', () => ({
  resolveYouTubeChannel: mocks.resolveYouTubeChannel,
}));

vi.mock('../../src/youtube-subscription', () => ({
  listChannelYouTubeSubscriptions: mocks.listChannelYouTubeSubscriptions,
  listGuildYouTubeSubscriptions: mocks.listGuildYouTubeSubscriptions,
}));

const APPLICATION_ID = '123456789012345678';
const GUILD_ID = '234567890123456789';
const CHANNEL_ID = '345678901234567890';
const OTHER_CHANNEL_ID = '456789012345678901';
const ROLE_ID = '567890123456789012';
const YOUTUBE_CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

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
    const subscription =
      env.YOUTUBE_SUBSCRIPTIONS.getByName(YOUTUBE_CHANNEL_ID);
    const addSubscriber = vi
      .spyOn(subscription, 'addSubscriber')
      .mockResolvedValue(undefined);
    vi.spyOn(env.YOUTUBE_SUBSCRIPTIONS, 'getByName').mockReturnValue(
      subscription,
    );
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
    mocks.listChannelYouTubeSubscriptions.mockResolvedValue([
      YOUTUBE_CHANNEL_ID,
    ]);
    const subscription =
      env.YOUTUBE_SUBSCRIPTIONS.getByName(YOUTUBE_CHANNEL_ID);
    const removeSubscriber = vi
      .spyOn(subscription, 'removeSubscriber')
      .mockResolvedValue(undefined);
    vi.spyOn(env.YOUTUBE_SUBSCRIPTIONS, 'getByName').mockReturnValue(
      subscription,
    );
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

    const response = await handleYouTubeCommand(
      interaction('list'),
      env,
      createExecutionContext(),
    );
    const list = await content(response);

    expect(list.length).toBeLessThanOrEqual(2_000);
    expect(list).toContain(`Current channel → <#${CHANNEL_ID}>*`);
    expect(list).not.toContain('https://');
    expect(list).toMatch(/…and \d+ more\.$/);
    expect(list.indexOf('Current channel')).toBeLessThan(
      list.indexOf('Long channel'),
    );
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

    await expect(content(response)).resolves.toBe(
      'This interaction is not supported.',
    );
    expect(mocks.resolveYouTubeChannel).not.toHaveBeenCalled();
  });

  it('logs provider and action context when listing fails', async () => {
    const error = new Error('KV unavailable');
    mocks.listGuildYouTubeSubscriptions.mockRejectedValue(error);
    const logger = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await handleYouTubeCommand(
      interaction('list'),
      env,
      createExecutionContext(),
    );

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
