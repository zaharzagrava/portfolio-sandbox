// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Off: it declares result casts like (await sequelize.query(...)) as { id: string }[] unnecessary because the library types the
      // result as object[]; its auto-fix then deletes them and the code stops compiling. tsc covers the real cases.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/only-throw-error': 'warn',

      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',

    },
  },
  {
    // S54 G-74 / AS-151: time comes from the injected CLOCK in the toolkit libs (mirrors scripts/check-no-wallclock.ts).
    files: [
      'libs/common/{resilience,load-shedding,core}/**/*.ts',
      'libs/infrastructure/{health,http-client,net,idempotency,context}/**/*.ts',
    ],
    ignores: ['**/clock.ts', '**/*.spec.ts', '**/*.e2e-spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Inject CLOCK instead of Date.now().' },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Inject CLOCK instead of new Date().' },
        { selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']", message: 'Inject CLOCK instead of performance.now().' },
      ],
    },
  },
  {
    // Test doubles are often `async` stand-ins for a port that returns a promise; that is not a defect in a spec.
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    // S54 G-58: outbound HTTP goes through ResilientHttpClient (timeouts, retries, breaker); axios has none of that by default.
    files: ['apps/**/*.ts', 'libs/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['libs/infrastructure/http-client/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'axios', message: 'Use ResilientHttpClient from @app/infrastructure/http-client.' }, { name: '@nestjs/axios', message: 'Use ResilientHttpClient from @app/infrastructure/http-client.' }] },
      ],
    },
  },
);