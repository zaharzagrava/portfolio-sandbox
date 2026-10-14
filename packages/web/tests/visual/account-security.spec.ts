import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { register } from '../helpers';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';

/**
 * VA rows of W01 (AS-45..AS-47, AS-53, AS-54, AS-57): Account security at the phone (390 x 844) and desktop (1280 x 800)
 * widths. The member is real (registered through the UI, so the server guard passes); the data the panels read is stubbed
 * with fixed bodies so the pictures are stable. Times are masked (they are relative to the clock).
 */

// The dev server's indicator is not part of the product and would end up in every baseline.
const stylePath = path.join(__dirname, 'hide-dev-overlay.css');

const KEY = 'JBSWY3DPEHPK3PXP';
const CODES = ['ABCDE-FGHJK', 'MNPQR-STUVW', 'XYZ23-45678', 'ABCD2-34567', 'BCDEF-GHJKM', 'NPQRS-TUVWX', 'YZ234-56789', 'CDEFG-HJKMN', 'PQRST-UVWXY', 'Z2345-6789A'];
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const SESSIONS = [
  { sessionId: 's-here', device: 'Chrome on Linux', ip: '203.0.113.7', createdAt: '2026-05-30T09:00:00.000Z', lastUsedAt: '2026-05-31T09:00:00.000Z', current: true },
  { sessionId: 's-phone', device: 'Safari on iPhone', ip: '198.51.100.23', createdAt: '2026-05-20T09:00:00.000Z', lastUsedAt: '2026-05-29T09:00:00.000Z', current: false },
  { sessionId: 's-old', device: 'Firefox on Windows', ip: '192.0.2.44', createdAt: '2026-04-01T09:00:00.000Z', lastUsedAt: '2026-04-02T09:00:00.000Z', current: false },
];

async function stubData(page: Page, mfa: Record<string, unknown>) {
  await page.route('**/api/auth/mfa', (route) => (route.request().method() === 'GET' ? route.fulfill(json(mfa)) : route.fallback()));
  await page.route('**/api/auth/mfa/enroll', (route) =>
    route.fulfill(json({ otpauthUri: `otpauth://totp/Marketplace:member@example.com?secret=${KEY}&issuer=Marketplace`, manualEntryKey: KEY })),
  );
  await page.route('**/api/auth/mfa/confirm', (route) => route.fulfill(json({ recoveryCodes: CODES })));
  await page.route('**/api/auth/sessions', (route) => route.fulfill(json(SESSIONS)));
  await page.route('**/api/auth/identities', (route) => route.fulfill(json([])));
}

const main = (page: Page) => page.locator('#main-content');

/** The rules every state shares: no serious axe finding, and nothing sticks out at 320 px. */
async function expectAccessibleAndContained(page: Page) {
  await expectNoSeriousViolations(page);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  // The tab list switches orientation in React after the media query changes: measure once it has.
  const tablist = page.getByRole('tablist', { name: 'Account security sections' });
  if (await tablist.count()) await expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
  await expectMainFitsWidth(page);
  if (original) await page.setViewportSize(original);
}

test.describe('Account security layout', () => {
  test('W01 AS-45 VA two-step: enabled, none', async ({ page }) => {
    await register(page);
    await stubData(page, { state: 'none' });
    await page.goto('/account/security');
    await expect(page).toHaveTitle('Account security · Marketplace');
    await expect(page.getByRole('heading', { level: 1, name: 'Account security' })).toBeVisible();
    await expect(page.getByText('Two-step verification is off.')).toBeVisible();
    await expect(main(page)).toHaveScreenshot('two-step-none.png', { stylePath });
    await expectAccessibleAndContained(page);

    await page.unroute('**/api/auth/mfa');
    await page.route('**/api/auth/mfa', (route) =>
      route.request().method() === 'GET' ? route.fulfill(json({ state: 'enabled', enabledAt: '2026-03-05T12:00:00.000Z', recoveryCodesRemaining: 2 })) : route.fallback(),
    );
    await page.reload();
    await expect(page.getByText('Only 2 recovery codes left. Get new ones soon.')).toBeVisible();
    await expect(main(page)).toHaveScreenshot('two-step-enabled.png', { stylePath });
    await expectAccessibleAndContained(page);
  });

  test('W01 AS-46 VA two-step: setup dialog', async ({ page }) => {
    await register(page);
    await stubData(page, { state: 'none' });
    await page.goto('/account/security');
    await page.getByRole('button', { name: 'Set up' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set up two-step verification' });
    await expect(dialog.getByRole('img', { name: /QR code for your authenticator app/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeInViewport();
    await expect(dialog).toHaveScreenshot('setup-dialog.png', { stylePath });
    await expectAccessibleAndContained(page);
  });

  test('W01 AS-47 VA two-step: recovery codes', async ({ page }) => {
    await register(page);
    await stubData(page, { state: 'none' });
    await page.goto('/account/security');
    await page.getByRole('button', { name: 'Set up' }).click();
    const setup = page.getByRole('dialog', { name: 'Set up two-step verification' });
    await setup.getByRole('button', { name: 'Next' }).click();
    await setup.getByLabel('6-digit code').fill('123456');
    await setup.getByRole('button', { name: 'Confirm' }).click();
    const codes = page.getByRole('dialog', { name: 'Save your recovery codes' });
    await expect(codes.getByRole('listitem')).toHaveCount(10);
    await expect(codes.getByRole('button', { name: 'Done' })).toBeInViewport();
    await expect(codes).toHaveScreenshot('recovery-codes.png', { stylePath });
    await expectAccessibleAndContained(page);
  });

  test('W01 AS-53 VA security: tabs and dialogs', async ({ page }) => {
    await register(page);
    await stubData(page, { state: 'enabled', enabledAt: '2026-03-05T12:00:00.000Z', recoveryCodesRemaining: 8 });
    await page.goto('/account/security');
    const tabs = page.getByRole('tablist', { name: 'Account security sections' });
    await expect(tabs.getByRole('tab', { name: 'Two-step verification' })).toHaveAttribute('aria-selected', 'true');
    await expect(tabs).toHaveScreenshot('tabs.png', { stylePath });
    await page.getByRole('button', { name: 'Turn off' }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn off two-step verification' });
    await expect(dialog.getByRole('button', { name: 'Turn off' })).toBeInViewport();
    await expect(dialog).toHaveScreenshot('turn-off-dialog.png', { stylePath });
    await expectAccessibleAndContained(page);
  });

  test('W01 AS-57 VA sessions: table (desktop), cards (mobile)', async ({ page }) => {
    await register(page);
    await stubData(page, { state: 'none' });
    await page.goto('/account/security?tab=sessions');
    await expect(page.getByText('Safari on iPhone')).toBeVisible();
    const wide = (page.viewportSize()?.width ?? 0) >= 1024;
    await expect(page.getByRole('table')).toHaveCount(wide ? 1 : 0);
    await expect(main(page)).toHaveScreenshot('sessions.png', { stylePath, mask: [page.locator('time')] });
    await expectAccessibleAndContained(page);
  });
});
