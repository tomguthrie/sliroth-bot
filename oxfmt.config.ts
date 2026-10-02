import { defineConfig } from 'oxfmt';

export default defineConfig({
  singleQuote: true,
  sortImports: {},
  sortPackageJson: {
    sortScripts: true,
  },
  ignorePatterns: [
    '**/coverage/**',
    '**/dist/**',
    '**/.cloudflare/**',
    '**/src/db/**/migrations/**',
  ],
});
