import { readFile } from 'node:fs/promises';

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';
const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;

const applicationId = requireSnowflake(
  process.env.DISCORD_APPLICATION_ID,
  'DISCORD_APPLICATION_ID',
);
const botToken = requireEnvironmentVariable('DISCORD_BOT_TOKEN');
const guildId = optionalSnowflake(process.env.DISCORD_GUILD_ID);
const command = JSON.parse(
  await readFile(
    new URL('../src/discord/youtube-command.json', import.meta.url),
    'utf8',
  ),
);
const synchronizedCommand = structuredClone(command);
if (guildId !== undefined) {
  delete synchronizedCommand.integration_types;
  delete synchronizedCommand.contexts;
}

const path =
  guildId === undefined
    ? `applications/${applicationId}/commands`
    : `applications/${applicationId}/guilds/${guildId}/commands`;
const response = await fetch(new URL(path, DISCORD_API_BASE_URL), {
  method: 'PUT',
  headers: {
    authorization: `Bot ${botToken}`,
    'content-type': 'application/json',
    'user-agent':
      'DiscordBot (https://github.com/tomguthrie/sliroth-bot, 0.0.0)',
  },
  body: JSON.stringify([synchronizedCommand]),
});

if (!response.ok) {
  throw new Error(
    `Discord command synchronization failed with HTTP ${response.status}: ${await response.text()}`,
  );
}

if (response.body !== null) {
  await response.body.cancel();
}
console.log(
  guildId === undefined
    ? 'Synchronized global Discord commands.'
    : `Synchronized Discord commands in guild ${guildId}.`,
);

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

function optionalSnowflake(value) {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!DISCORD_SNOWFLAKE.test(value)) {
    throw new Error('DISCORD_GUILD_ID must be a Discord snowflake');
  }
  return value;
}
