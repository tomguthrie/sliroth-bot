# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Version Control

This repository uses Jujutsu (`jj`). Never run Git commands in this repository.

- Work in one logical jj changeset at a time.
- After implementing and verifying a changeset, describe it with `jj describe -m "<description>"`.
- Show `jj st` and `jj diff` or `jj diff --stat`, then stop and ask the user to review the changeset.
- Do not start the next changeset until the user explicitly approves the current one.
- After approval, create the next changeset with `jj new -m "<description>"`.
- Never push changes or move/create remote-facing bookmarks unless the user explicitly changes these instructions.
- Always pass `-m` to jj commands that accept a description, and never invoke interactive jj commands.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command               | Purpose                   |
| --------------------- | ------------------------- |
| `npx wrangler dev`    | Local development         |
| `npx wrangler deploy` | Deploy to Cloudflare      |
| `npx wrangler types`  | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Durable Object Persistence

- Use Drizzle ORM and generated Drizzle migrations for Durable Object SQLite schemas and queries.
- Do not create or migrate application tables with inline DDL in Durable Object constructors.
- Keep each Durable Object schema under `src/db/<name>/schema.ts`, its Drizzle Kit config under `drizzle/`, and initialize it with `drizzle(...)` and `migrate(...)`.

## TypeScript

Use the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) for review-time guidance that is not already enforced by ESLint or Prettier. Let those tools own mechanical style and formatting.

- Use ES modules and prefer named exports. The Worker's required `export default` handler is the exception. Keep module APIs small, do not use mutable exports (`export let`), and use module-level functions and constants instead of static container classes.
- Use `import type` and `export type` when a symbol is used or re-exported only as a type.
- Rely on inference for obvious local types. Add annotations when they clarify a complex expression, define a public contract, or make a structural object implementation fail at its declaration rather than at a distant use site.
- Prefer optional fields and parameters over explicit `| undefined`. Add `null` or `undefined` at the point of use instead of baking absence into reusable type aliases, and handle absent values close to where they originate.
- Treat type assertions and non-null assertions as unsafe. Prefer runtime checks and narrowing; when an assertion is genuinely necessary and its safety is not obvious, explain why. Do not use double assertions to force unrelated types.
- Annotate object literals or function return types instead of asserting object literals with `as`, so excess and renamed properties remain type checked.
- Use the simplest type construct that expresses the model. Prefer explicit types and composition over hard-to-read mapped or conditional types; accept a little repetition when it improves maintainability and tooling support.
- Prefer `Map` or `Set` for dynamic collections. Use `Record` when the keys are statically known, and give index-signature keys meaningful names when an index signature is appropriate.
- Avoid APIs whose generic type appears only in the return type. For an existing return-only-generic API, supply the type argument explicitly.
- Mark class properties `readonly` when they are not reassigned after construction, and use parameter properties for straightforward constructor-injected fields.
- Use JSDoc for exported API contracts and non-obvious constraints; use ordinary comments for implementation details. Comments should explain information the code and types do not already convey.

### Zod

- When a Zod schema is the source of truth for a type, give the schema and inferred type the same PascalCase name:

  ```ts
  export const Player = z.object({
    username: z.string(),
    xp: z.number(),
  });

  export type Player = z.infer<typeof Player>;
  ```

- Use `safeParse()` at expected untrusted-data boundaries when invalid input must be translated into a domain error, HTTP response, structured log, or skipped record.
- Pass untrusted values directly to `safeParse()`. Do not introduce an intermediate such as `const value: unknown = ...` when it is only forwarded to `safeParse()` on the next line; retain a named value only when it improves reuse, logging, or control flow.
- When validated wire data is immediately and mechanically renamed or normalized into a domain type, prefer a Zod `.transform()` and infer the domain type from that schema instead of maintaining separate wire types, domain interfaces, and mapper functions. Keep actual domain decisions and side effects outside schema transforms.
- Use Zod brands for validated identifiers and other primitives that must not be mixed accidentally. Infer the branded type from the schema, accept the schema's unbranded input type at external boundaries, and use the parsed branded output internally. Do not manufacture branded values with assertions or database type annotations unless the value was actually validated.
- Use `parse()` when invalid data represents an unexpected invariant failure that should propagate as an uncaught exception. Do not catch a `ZodError` only to rethrow an equivalent error.
- Parse an existing JSON string with `JSON.parse()` and validate the result immediately. Use `request.json()` or `response.json()` when consuming a `Request` or `Response`; do not construct a new `Response` solely to parse a string.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Logging

- Pass structured objects directly to `console` methods so Workers Logs can index their fields. Do not wrap log objects in `JSON.stringify`.
- Convert caught `Error` instances and their causes to plain enumerable data before placing them on an `error` field; nested `Error` objects otherwise appear empty in Workers Logs. Preserve non-`Error` caught values without coercing them with `String(error)`. Reserve `JSON.stringify` for actual serialization boundaries such as HTTP request bodies.

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
