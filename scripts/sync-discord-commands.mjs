import { readFile } from 'node:fs/promises';

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';
const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;

const applicationId = requireSnowflake('DISCORD_APPLICATION_ID');
const botToken = requireEnvironmentVariable('DISCORD_BOT_TOKEN');
const commands = await Promise.all(
  ['youtube', 'twitch'].map(async (name) =>
    JSON.parse(
      await readFile(
        new URL(
          `../src/discord/interactions/command/${name}.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  ),
);

const response = await fetch(
  new URL(`applications/${applicationId}/commands`, DISCORD_API_BASE_URL),
  {
    method: 'PUT',
    headers: {
      authorization: `Bot ${botToken}`,
      'content-type': 'application/json',
      'user-agent':
        'DiscordBot (https://github.com/tomguthrie/sliroth-bot, 0.0.0)',
    },
    body: JSON.stringify(commands),
  },
);

if (!response.ok) {
  throw new Error(
    `Discord command synchronization failed with HTTP ${response.status}: ${await response.text()}`,
  );
}

if (response.body !== null) {
  await response.body.cancel();
}
console.log('Synchronized global Discord commands.');

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireSnowflake(name) {
  const required = requireEnvironmentVariable(name);
  if (!DISCORD_SNOWFLAKE.test(required)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
  return required;
}
