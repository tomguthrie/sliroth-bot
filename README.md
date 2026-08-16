# Sliroth Bot

A Cloudflare Worker that messages a Discord channel whenever a YouTube video is
uploaded to a specific channel.

## Development

```sh
pnpm i
pnpm check
```

Runtime configuration is declared in `wrangler.jsonc`. Secret values must be
configured through Cloudflare or a local `.dev.vars` file.

## Database migrations

Each Durable Object has an independent Drizzle Kit configuration, schema, and
migration history. Generate every pending migration with:

```sh
pnpm db:generate
```

Apply the Twitch analytics D1 migrations with:

```sh
pnpm db:migrate:twitch-analytics:local
pnpm db:migrate:twitch-analytics:remote
```

## Twitch analytics setup

Set `TWITCH_ANALYTICS_CHANNEL_ID` to the numeric broadcaster ID and set a long,
random `TWITCH_ANALYTICS_SETUP_SECRET`. After deployment, request
`/twitch/analytics/setup` with that secret as a bearer token and open the URL
from the response's `Location` header to authorize the configured broadcaster:

```sh
curl --silent --dump-header - --output /dev/null \
  --header "Authorization: Bearer $TWITCH_ANALYTICS_SETUP_SECRET" \
  "$PUBLIC_BASE_URL/twitch/analytics/setup"
```

The redirect URI registered for the Twitch application must be
`$PUBLIC_BASE_URL/twitch/analytics/callback`.
