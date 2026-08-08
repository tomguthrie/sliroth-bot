import { readFile } from 'node:fs/promises';

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';
const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;

const applicationId = requireSnowflake(
  process.env.DISCORD_APPLICATION_ID,
  'DISCORD_APPLICATION_ID',
);
const botToken = requireEnvironmentVariable('DISCORD_BOT_TOKEN');
const command = JSON.parse(
  await readFile(
    new URL('../src/discord/youtube-command.json', import.meta.url),
    'utf8',
  ),
);

const guildsResponse = await discordRequest('users/@me/guilds?limit=200');
const guilds = await guildsResponse.json();
if (!Array.isArray(guilds)) {
  throw new Error('Discord returned an invalid guild list');
}

for (const guild of guilds) {
  if (!DISCORD_SNOWFLAKE.test(guild?.id)) {
    throw new Error('Discord returned a guild with an invalid ID');
  }

  const response = await discordRequest(
    `applications/${applicationId}/guilds/${guild.id}/commands`,
    {
      method: 'PUT',
      body: '[]',
    },
  );
  await cancelResponseBody(response);
}
console.log(`Cleared commands from ${guilds.length} Discord guilds.`);

const response = await discordRequest(
  `applications/${applicationId}/commands`,
  {
    method: 'PUT',
    body: JSON.stringify([command]),
  },
);
await cancelResponseBody(response);
console.log('Synchronized global Discord commands.');

async function discordRequest(path, init = {}) {
  const response = await fetch(new URL(path, DISCORD_API_BASE_URL), {
    ...init,
    headers: {
      authorization: `Bot ${botToken}`,
      'content-type': 'application/json',
      'user-agent':
        'DiscordBot (https://github.com/tomguthrie/sliroth-bot, 0.0.0)',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Discord command synchronization failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }

  return response;
}

async function cancelResponseBody(response) {
  if (response.body !== null) {
    await response.body.cancel();
  }
}

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireSnowflake(value, name) {
  const required = requireEnvironmentVariable(name);
  if (!DISCORD_SNOWFLAKE.test(required)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
  return required;
}
