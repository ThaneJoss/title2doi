import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', '.wrangler/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', '*.config.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['app.mjs', 'core.mjs', 'tests/e2e/**/*.mjs'],
    languageOptions: { globals: globals.browser },
  },
];
