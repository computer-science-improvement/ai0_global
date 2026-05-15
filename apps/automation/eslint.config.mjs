// Minimal flat config (ESLint 9/10 style).
//
// Goal: act as a syntax-and-parser check in CI rather than a strict style
// enforcer. The codebase predates any lint configuration and shipping a strict
// rule set today would surface hundreds of pre-existing issues that block the
// multi-env PR. Stylistic / preference rules are turned off here; revisit and
// tighten in a dedicated follow-up.
//
// What this config DOES catch:
//   - TypeScript / JavaScript syntax errors
//   - Truly broken references (no-undef via the TS parser)
//
// What it deliberately ignores (for now):
//   - Unused variables in legacy files (warns only, won't fail CI)
//   - `any` usage
//   - Empty functions / catch blocks

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Ignore patterns — applied globally.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.d.ts',
    ],
  },

  // Base JS recommended rules.
  js.configs.recommended,

  // TypeScript recommended rules (without type-checking — keeps lint fast).
  ...tseslint.configs.recommended,

  // Project-specific overrides.
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      // Warn (not error) on unused vars; legacy code has plenty of unused
      // imports we don't want to chase right now. `_`-prefixed names are
      // a NodeJS / Nest convention for intentionally-unused params.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // The codebase uses `any` in many places (Telegram payloads,
      // dynamic JSON config). Off until we type those properly.
      '@typescript-eslint/no-explicit-any': 'off',

      // Empty functions appear in interface stubs (e.g. strategies that
      // don't implement fetch/generate).
      '@typescript-eslint/no-empty-function': 'off',

      // require() is used in some Telegram MTProto bootstrapping
      // (input library quirks). Don't fail CI on that.
      '@typescript-eslint/no-require-imports': 'off',

      // `no-explicit-any` and `no-unsafe-*` rules need type-checked linting
      // which we don't enable here. Off by default in the non-typed preset.

      // Allow `let foo: any = …` in places where we widen on purpose.
      'prefer-const': 'warn',

      // ESLint's no-prototype-builtins is overzealous for Record<> shapes.
      'no-prototype-builtins': 'off',

      // The following rules surface real-but-low-impact issues that exist
      // across the legacy codebase (regex escapes, dead assignments, error
      // rethrows). Downgraded to warnings so they're visible in CI output
      // but don't fail the build. A dedicated cleanup PR can flip these
      // back to errors once the existing instances are fixed.
      'no-useless-escape':       'warn',
      'no-useless-assignment':   'warn',
      'preserve-caught-error':   'warn',
    },
  },
);
