AGENTS.md SHOULD NEVER be added to tracking. It SHOULD NEVER be added to `.gitignore`; ignore it locally through `.git/info/exclude`.

# Repository guide

## Repository structure

This is a single-package pnpm project containing a Cloudflare Worker:

- `src/`: Worker entrypoint, Discord integration, Twitch and YouTube subscriptions, Queue processing, and Durable Objects.
- `src/db/`: Drizzle schemas and generated migration histories for the Durable Object databases.
- `test/`: Worker-runtime tests using the `.spec.ts` extension.
- `drizzle/`: Drizzle Kit configuration for each Durable Object database.
- `scripts/`: Local operational scripts, including Discord command synchronization.

## Top-level pnpm commands

- `pnpm dev`: run the Worker locally with Wrangler.
- `pnpm deploy`: deploy the Worker without synchronizing Discord commands.
- `pnpm discord:sync-commands`: synchronize global Discord commands explicitly.
- `pnpm fmt`: format the repository with Oxfmt.
- `pnpm lint`: lint the repository with Oxlint and deny warnings.
- `pnpm typecheck`: validate generated Worker types and type-check source and tests.
- `pnpm check`: check formatting, linting, and types.
- `pnpm test`: run the test suite.
- `pnpm db:generate:twitch-subscription`: generate Twitch subscription Durable Object migrations.
- `pnpm db:generate:youtube-subscription`: generate YouTube subscription Durable Object migrations.
- `pnpm db:check:twitch-subscription`: validate Twitch subscription migrations.
- `pnpm db:check:youtube-subscription`: validate YouTube subscription migrations.

## Version control

This repository uses Jujutsu (`jj`). Never run Git commands.

- Work in one logical changeset at a time.
- After implementing and verifying a changeset, describe it with `jj describe -m "<description>"`.
- Show `jj st` and `jj diff` or `jj diff --stat`, then stop for review.
- Do not create the next changeset until the current one is explicitly approved.
- Never push or move remote-facing bookmarks unless explicitly requested.

## Cloudflare Workers

Retrieve current Cloudflare documentation before changing Workers APIs, Wrangler configuration, bindings, Durable Objects, Queues, or platform limits. Treat `wrangler.jsonc` as the Worker configuration source of truth and run `pnpm cf-typegen` after changing bindings.

Use Drizzle ORM and generated Drizzle migrations for Durable Object SQLite schemas. Do not create or migrate application tables with inline DDL in Durable Object constructors.

## Testing

Tests live under `test/` and use the `.spec.ts` extension.

When fixing an issue, add a regression test that fails without the fix and passes after the fix. This ensures the same behaviour cannot silently regress. If the fix relates to a GitHub issue, place a link to that issue in a comment immediately above the relevant test.

Do not add tests merely to increase coverage. Tests should exercise important behaviour and provide useful confidence rather than test boilerplate or implementation details.

## Comments and documentation

Document every public export with TSDoc. Briefly describe what the exported function, type, class, or value does, and include important constraints or behaviour that may not be obvious from its signature.

Add implementation comments when the purpose or reasoning is unclear. Comments should explain why something is necessary, not simply repeat what the code does. Avoid historical commentary; source control already records the history.

## Zod schemas

Use Zod to parse external API responses, request bodies, decrypted or loaded JSON, persisted JSON, and other public JSON boundaries. Use Zod internally when it meaningfully replaces substantial handwritten structural validation.

Do not redundantly parse data that is already runtime-validated and precisely typed. Prefer direct guards for simple invariants and non-data capability checks.

Do not add implementation code solely to reproduce an old error's exact wording when a replacement error communicates the same failure. Preserve exact text only when it is a documented public or user-facing contract; otherwise, make tests assert stable semantics rather than incidental wording.

When a Zod schema defines a domain type, name the schema after the domain type in PascalCase and infer the TypeScript type from that same schema. Do not use a separate lowercase or `*Schema` constant for this pattern.

```ts
const TwitchStream = z.object({
  // ...
});

export type TwitchStream = z.infer<typeof TwitchStream>;
```

## Engineering guidelines

- Always use Drizzle for database access. Do not issue raw SQL through D1 or Durable Object storage.
- Trace the affected flow and its callers before changing code. Fix bugs at their shared cause rather than patching individual symptoms.
- Prefer existing repository code, standard library functions, native platform features, and installed dependencies before introducing custom machinery.
- Implement the current requirement. Add abstractions, configuration, and extension points only when a concrete use case requires them.
- Choose the smallest change that remains clear and correct. Do not trade readability, validation, security, accessibility, or failure handling for fewer lines.
- When a deliberate shortcut has a known limitation, briefly document that limitation and what would justify replacing it.
- Follow the conventions already established by the surrounding code.
- Avoid unrelated refactors while making a focused change.
- Keep changes scoped to the task unless another change is necessary for correctness.
- Preserve existing public APIs unless the task requires changing them.
- Keep TypeScript types precise. Do not weaken them with `any` unless there is a strong, documented reason, and avoid assertions that hide incompatibilities.
- Do not change, disable, or suppress a lint rule without approval. If satisfying a lint appears to require less readable, less idiomatic, or less correct code, stop and report the rule, diagnostic, natural implementation, and proposed workaround so it can be discussed first.
- Pass structured objects directly to `console` methods and convert caught `Error` instances to enumerable data before logging them.
- Treat lint, type-check, and test failures introduced by a change as part of that change, and resolve them before completion.
