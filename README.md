# Sliroth Bot

A Cloudflare Worker that messages a Discord channel whenever a YouTube video is
uploaded to a specific channel.

## Development

```sh
npm install
npm run check
```

Runtime configuration is declared in `wrangler.jsonc`. Secret values must be
configured through Cloudflare or a local `.dev.vars` file.
