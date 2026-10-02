# Sliroth Bot

A Cloudflare Worker that messages a Discord channel whenever a YouTube video is
uploaded to a specific channel.

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
