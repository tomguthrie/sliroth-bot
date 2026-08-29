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
    '**/.wrangler/**',
    '**/src/db/**/migrations/**',
    '**/worker-configuration.d.ts',
  ],
});
