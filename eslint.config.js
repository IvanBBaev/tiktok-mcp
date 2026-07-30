import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['build/', 'coverage/', 'node_modules/', 'docs/', 'site/', 'extension/'] },

  js.configs.recommended,

  // Type-checked rules for all first-party TypeScript (server source + tests).
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // A forgotten await in an async handler silently drops errors.
      '@typescript-eslint/no-floating-promises': 'error',
      // stdout is the stdio JSON-RPC channel: console.log/info/debug (stdout)
      // are forbidden in the server source; console.warn/error (stderr, via the
      // redacting logger) remain allowed. Enforces CC-G3 stdout purity.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Time and timers must flow through the core/clock.ts seam so every
  // time-dependent behavior is testable under the mock clock (TESTING.md
  // determinism rule 1 / CC-H4). core/clock.ts itself is the seam and is
  // exempt below.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'setTimeout',
          message:
            'Use the core/clock.ts sleep seam so timing is testable under the mock clock.',
        },
        {
          name: 'setInterval',
          message:
            'Use the core/clock.ts seam so timing is testable under the mock clock.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message:
            'Use the core/clock.ts Clock seam so time is testable under the mock clock.',
        },
      ],
    },
  },
  {
    files: ['src/core/clock.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },

  // node:test's top-level test()/describe() return a promise the runner itself
  // manages; not awaiting them is the intended idiom, so this rule would only
  // produce noise in *.test.ts files.
  {
    files: ['src/**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // Layer boundaries — core <- api <- mcp <- tools — as import-x path zones:
  // a target directory may not import *from* the listed higher layers. cli/ is
  // the composition root (like tools/) and is intentionally unrestricted.
  {
    files: ['src/**/*.ts'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ project: './tsconfig.json' }),
      ],
    },
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/core',
              from: ['./src/api', './src/mcp', './src/tools', './src/cli'],
              message:
                'core is layer 0 — it must not import from api/, mcp/, tools/ or cli/.',
            },
            {
              target: './src/api',
              from: ['./src/mcp', './src/tools', './src/cli'],
              message: 'api is layer 1 — it must not import from mcp/, tools/ or cli/.',
            },
            {
              target: './src/mcp',
              from: ['./src/tools', './src/cli'],
              message: 'mcp is layer 2 — it must not import from tools/ or cli/.',
            },
          ],
        },
      ],
    },
  },

  // The same layer map expressed with string-based no-restricted-imports, so
  // enforcement never depends on module resolution.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/**', '**/mcp/**', '**/tools/**', '**/cli/**'],
              message:
                'core is layer 0 — it must not import from api/, mcp/, tools/ or cli/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/mcp/**', '**/tools/**', '**/cli/**'],
              message: 'api is layer 1 — it must not import from mcp/, tools/ or cli/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/mcp/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tools/**', '**/cli/**'],
              message: 'mcp is layer 2 — it must not import from tools/ or cli/.',
            },
          ],
        },
      ],
    },
  },

  // Plain JS/MJS (this config, future scripts): syntax-only.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },

  // CommonJS launcher shim (bin/*.cjs): must stay CJS so it parses on old Node
  // versions before it can print the engines error, so it needs the CJS
  // source type rather than the ESM default.
  {
    files: ['**/*.cjs'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // The launcher is deliberately ES5-shaped so the version guard still runs
      // (rather than dying at parse time) on the old runtimes it exists to warn.
      'no-var': 'off',
    },
  },

  prettier,
);
