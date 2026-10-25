import { defineConfig, devices } from '@playwright/test';

/** Port of the production-build server that `tests/security-headers.spec.ts` (and the widget bundle checks) run against. */
export const PROD_PORT = 3100;

// The production build is slow; start it for a full run (no spec file named), for a run that targets the specs that need
// it, or with W07_PROD=1.
const namesSpecFile = process.argv.some((arg) => /\.spec\.ts|(^|\/)tests\//.test(arg));
const needsProdServer =
  process.env.W07_PROD === '1' || !namesSpecFile || process.argv.some((arg) => /security-headers|widget-embed|app-shell\.prod/.test(arg));

/**
 * Specs that move the API's clock. J01 AS-29 calls `control.advance(49 * 3600)` for the weekly payout; while the clock is moved, every other
 * session on the stack gets `401 invalid_token`. Run next to cart-checkout JC-2 it failed that spec in every W04 and W05 gate for a night
 * (2026-10-17/18). So a normal run leaves these specs out, and they run on their own with `PW_CLOCK=1 pnpm test:e2e` (the SDD gate, the
 * checkpoint sweep and fresh-run.sh do it after the main run).
 */
const CLOCK_SPECS = /buy-to-payout\.spec\.ts$/;
const WITH_CLOCK = process.env.PW_CLOCK === '1';
const PHONE = { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };

/**
 * Track 6: the specs of the four seller areas (entry, inventory, media, orders) also run in Firefox. (WebKit, the Safari engine, was dropped on 2026-10-25: not needed for now.)
 * Only these files: the visual specs keep Chromium baselines, and the other specs are not part of the four areas. The projects exist
 * only with PW_BROWSERS=1 (`npx playwright install firefox` first), so a normal run
 * and the SDD gate are unchanged. Run: `PW_BROWSERS=1 npx playwright test --project=firefox-desktop`.
 */
const FOUR_AREAS = /(^|[\\/])(seller|seller-shop|seller-inventory|seller-photos)\.spec\.ts$|seller[\\/]cross-cutting[\\/](concurrency|isolation|a11y)\.spec\.ts$/;
const CROSS_BROWSER = process.env.PW_BROWSERS === '1';

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
  // The SDD gate sets PW_RETRIES=1: a test that fails and then passes is reported as "flaky" (and recorded), a test that is really broken fails
  // twice. About 450 browser tests on a loaded 2-worker machine fail at least one flake per full run; without a retry each flake cost a 40-minute
  // repair-and-gate cycle (W04, 2026-10-18).
  retries: process.env.PW_RETRIES !== undefined ? Number(process.env.PW_RETRIES) : process.env.CI ? 2 : 0,
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
  // The per-test limit must exceed the longest wait inside a test (checkout settles the payment within 45 s on a loaded runner).
  timeout: Number(process.env.PW_TEST_TIMEOUT_MS) || 90_000,
  expect: {
    // A loaded runner (two stacks, a dev server compiling pages on demand, parallel browsers) needs longer than 5 s for a page to settle;
    // the build machine sets PW_EXPECT_TIMEOUT_MS. The assertions themselves are unchanged.
    timeout: Number(process.env.PW_EXPECT_TIMEOUT_MS) || 5_000,
    toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{projectName}/{arg}{ext}',
  globalSetup: require.resolve('./tests/global-setup'),
  globalTeardown: require.resolve('./tests/global-teardown'),

  /* Run the dev server before starting the tests; the production build only for the specs that check real headers. */
  webServer: [
    {
      command: 'pnpm run dev',
      env: {
        PLATFORM_CURRENCY: 'EUR', // W04: the seller product form names the platform currency (the dev stack's backend books EUR)
        NEXT_PUBLIC_PAYMENTS_SANDBOX: 'true', // W03: the pay step shows the sandbox card picker (never in production builds)
        // W02: a tile source for the pickup map; the journeys answer its requests with a stub tile (no third-party host is ever called).
        NEXT_PUBLIC_MAP_TILE_URL: 'https://tiles.test.local/{z}/{x}/{y}.png',
        MAP_TILE_HOST: 'https://tiles.test.local',
      },
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
  projects: WITH_CLOCK
    ? [
        // PW_CLOCK=1: only the specs that move the API's clock, one after the other, nothing else running (see CLOCK_SPECS above).
        { name: 'clock-desktop', testMatch: CLOCK_SPECS, use: { ...DESKTOP } },
        { name: 'clock-mobile', testMatch: CLOCK_SPECS, dependencies: ['clock-desktop'], use: { ...PHONE } },
      ]
    : [
        // Phone: 390 x 844, touch.
        // One suite, two projects. A test titled with `@phone` is about the phone layout and runs only on the phone project; a test titled
        // with `@desktop` (behaviour, API, database, roles, concurrency) runs only on desktop; the older untagged tests run on both.
        { name: 'mobile', testIgnore: CLOCK_SPECS, grepInvert: /@desktop/, use: { ...PHONE } },
        { name: 'desktop', testIgnore: CLOCK_SPECS, grepInvert: /@phone/, use: { ...DESKTOP } },
        ...(CROSS_BROWSER
          ? [
              { name: 'firefox-desktop', testMatch: FOUR_AREAS, use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } } },
            ]
          : []),
      ],

});
