export const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';

export interface CreateDiscordVideoMessageRequestOptions {
  botToken: string;
  channelId: string;
  roleId: string;
  applicationUrl: string;
  videoId: string;
}

export function createDiscordVideoMessageRequest({
  botToken,
  channelId,
  roleId,
  applicationUrl,
  videoId,
}: CreateDiscordVideoMessageRequestOptions): Request {
  requireNonEmpty(botToken, 'Discord bot token');
  requireSnowflake(channelId, 'Discord channel ID');
  requireSnowflake(roleId, 'Discord role ID');
  requireNonEmpty(videoId, 'YouTube video ID');

  const applicationOrigin = new URL(applicationUrl).origin;
  const videoUrl = `https://youtu.be/${encodeURIComponent(videoId)}`;

  const body = {
    content: `<@&${roleId}> Sliroth just uploaded a video, go check it out! ${videoUrl}`,
    allowed_mentions: {
      parse: [],
      roles: [roleId],
    },
  };

  return new Request(
    new URL(`channels/${channelId}/messages`, DISCORD_API_BASE_URL),
    {
      method: 'POST',
      headers: {
        authorization: `Bot ${botToken}`,
        'content-type': 'application/json',
        'user-agent': `DiscordBot (${applicationOrigin}, 0.0.0)`,
      },
      body: JSON.stringify(body),
    },
  );
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim() === '') {
    throw new Error(`${name} cannot be empty`);
  }
}

function requireSnowflake(value: string, name: string): void {
  if (!/^[0-9]{17,20}$/.test(value)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
}
