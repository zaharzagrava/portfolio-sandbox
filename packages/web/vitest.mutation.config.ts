import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/** Narrow test set for mutation testing (`pnpm mutation:web`): only unit tests that exercise the logic files listed in stryker.config.json. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
      include: [
        'lib/seller/**/*.test.{ts,tsx}',
        'lib/api/seller-products.test.tsx',
        'lib/api/seller.test.tsx',
        'lib/auth/**/*.test.{ts,tsx}',
        'lib/redirects.test.ts',
        'lib/safe-link.test.ts',
        'components/seller/**/*.test.{ts,tsx}',
        'components/dashboard/**/*.test.{ts,tsx}',
        'app/dashboard/seller/**/*.test.{ts,tsx}',
        'proxy.test.ts',
      ],
  },
});
