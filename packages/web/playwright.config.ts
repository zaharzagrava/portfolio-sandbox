import { defineConfig, devices } from '@playwright/test';

/** Port of the production-build server that `tests/security-headers.spec.ts` (and the widget bundle checks) run against. */
export const PROD_PORT = 3100;

// The production build is slow; start it for a full run (no spec file named), for a run that targets the specs that need
// it, or with W07_PROD=1.
const namesSpecFile = process.argv.some((arg) => /\.spec\.ts|(^|\/)tests\//.test(arg));
const needsProdServer =
  process.env.W07_PROD === '1' || !namesSpecFile || process.argv.some((arg) => /security-headers|widget-embed/.test(arg));

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : 2, // one local dev stack: keep the load (and RAM) modest
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [['list'], ['html', { open: 'never' }]],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  expect: {
    toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{projectName}/{arg}{ext}',
  globalSetup: require.resolve('./tests/global-setup'),
  globalTeardown: require.resolve('./tests/global-teardown'),

  /* Run the dev server before starting the tests; the production build only for the specs that check real headers. */
  webServer: [
    {
      command: 'pnpm run dev',
      env: { NEXT_PUBLIC_PAYMENTS_SANDBOX: 'true' }, // W03: the pay step shows the sandbox card picker (never in production builds)
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000, // Give Next.js time to compile
    },
    ...(needsProdServer
      ? [
          {
            // Separate distDir: the dev server keeps using `.next`.
            command: 'pnpm run build:e2e && pnpm run start:e2e', // port 3100 = PROD_PORT
            url: `http://localhost:${PROD_PORT}`,
            reuseExistingServer: !process.env.CI,
            timeout: 600 * 1000,
          },
        ]
      : []),
  ],

  /* Configure projects for major browsers */
  projects: [
    // Phone: 390 x 844, touch.
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
});
