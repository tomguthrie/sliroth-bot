# Sliroth Bot

A Cloudflare Worker that posts Discord notifications when a Twitch channel goes
live or a YouTube channel uploads a video. Twitch notifications are updated
while the stream is live and replaced with a summary and VOD link when it ends.

Discord server members with the Manage Server permission configure notifications
for the current channel with the `/twitch` and `/youtube` commands, each of which
has `add`, `list`, and `remove` subcommands.

## Development

```sh
pnpm install
pnpm dev
```

Validate and build locally without deploying:

```sh
pnpm fmt
pnpm check
pnpm test
pnpm build
```

## Discord commands

`pnpm deploy` does not change the bot's slash commands. After editing
`src/twitch/discord-command.json` or `src/youtube/discord-command.json`,
synchronize the global commands explicitly:

```sh
DISCORD_APPLICATION_ID=… DISCORD_BOT_TOKEN=… pnpm discord:sync-commands
```

## Database migrations

Each Durable Object has an independent Drizzle Kit configuration, schema, and
migration history. Generate or check migrations explicitly for the relevant
schema:

```sh
pnpm db:generate:twitch-subscription
pnpm db:generate:youtube-subscription
pnpm db:check:twitch-subscription
pnpm db:check:youtube-subscription
```
