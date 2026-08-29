import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import', 'promise', 'vitest'],
  categories: {
    correctness: 'error',
  },
  ignorePatterns: [
    '**/coverage/**',
    '**/dist/**',
    '**/.wrangler/**',
    '**/src/db/**/migrations/**',
    '**/worker-configuration.d.ts',
  ],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: 'error',
    typeAware: true,
  },
  rules: {
    curly: ['error', 'all'],
    'typescript/consistent-type-imports': [
      'error',
      {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      },
    ],
    'typescript/no-explicit-any': 'error',
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/prefer-nullish-coalescing': 'warn',
  },
});
