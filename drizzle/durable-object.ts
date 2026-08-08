import { defineConfig } from 'drizzle-kit';

/** Creates an isolated Drizzle Kit configuration for a Durable Object class. */
export function defineDurableObjectConfig(name: string) {
  return defineConfig({
    dialect: 'sqlite',
    driver: 'durable-sqlite',
    schema: `./src/db/${name}/schema.ts`,
    out: `./src/db/${name}/migrations`,
  });
}
