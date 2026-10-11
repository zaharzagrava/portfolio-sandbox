import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * VN rows of W01 (AS-17, AS-18, AS-19): the navbar account area in its three states, at the phone and desktop widths.
 * The server reads the session from the HttpOnly cookie, which a browser-side stub cannot fake, so every page is served
 * as anonymous and "signed in" is reached the way a real tab gets there: the tab regains focus and the session query
 * (`GET /api/bff/session`, stubbed here) answers with a member.
 */

const MEMBER = { user: { id: 'u1', email: 'long.address.for.wrapping@example.com', role: 'SELLER' }, expiresAt: '2099-01-01T00:00:00.000Z' };

async function stubSession(page: Page, member: typeof MEMBER | null) {
  await page.route('**/api/bff/session', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return member
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(member) })
      : route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'unauthenticated' }) });
  });
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;

/** Becomes a member in the browser: re-check the session on focus until the account control reflects it. */
async function becomeMember(page: Page) {
  await stubSession(page, MEMBER);
  await page.goto('/');
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('link', { name: 'Log in' })).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 15_000 });
}

async function seriousViolations(page: Page, selector: string) {
  const { violations } = await new AxeBuilder({ page }).include(selector).analyze();
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}

test.describe('W01 VN: navbar account area', () => {
  test('W01 AS-17 VN anonymous: Log in and Sign up at desktop; icon link and sheet entries on the phone', async ({ page }) => {
    await stubSession(page, null);
    await page.goto('/');
    const header = page.getByRole('banner');
    if (isPhone(page)) {
      await expect(header.getByRole('link', { name: 'Log in' })).toBeVisible();
      await expect(header).toHaveScreenshot('anonymous-header.png');
      await page.getByRole('button', { name: 'Open menu' }).click();
      const sheet = page.getByRole('dialog', { name: 'Menu' });
      await expect(sheet.getByRole('link', { name: 'Log in' })).toBeVisible();
      await expect(sheet.getByRole('link', { name: 'Sign up' })).toBeVisible();
      await expect(sheet).toHaveScreenshot('anonymous-sheet.png');
      expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    } else {
      await expect(header.getByRole('link', { name: 'Log in' })).toBeVisible();
      await expect(header.getByRole('link', { name: 'Sign up' })).toBeVisible();
      await expect(header).toHaveScreenshot('anonymous-header.png');
      expect(await seriousViolations(page, 'header')).toEqual([]);
    }
  });

  test('W01 AS-18 VN loading: resolving the account area moves nothing (no layout shift)', async ({ page }) => {
    // The placeholder itself exists only while the server renders the slot, which a browser cannot hold open; what the
    // placeholder guarantees (same size, so nothing shifts) is measured on the page that follows.
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number };
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] }[]) {
          const inHeader = entry.sources?.some((s) => s.node && (s.node as Element).closest?.('header'));
          if (!entry.hadRecentInput && inHeader) w.__cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await becomeMember(page);
    if (!isPhone(page)) await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.01);
    if (!isPhone(page)) {
      const box = await page.getByRole('button', { name: 'Account menu' }).boundingBox();
      expect(box?.width).toBe(36);
      expect(box?.height).toBe(36);
    }
  });

  test('W01 AS-19 VN signed in: menu open (desktop menu, phone sheet)', async ({ page }) => {
    await becomeMember(page);
    if (isPhone(page)) {
      await expect(page.getByRole('link', { name: 'Log in' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Open menu' }).click();
      const sheet = page.getByRole('dialog', { name: 'Menu' });
      const group = sheet.getByRole('group', { name: 'Account' });
      await expect(group.getByText(MEMBER.user.email)).toBeVisible();
      await expect(group).toHaveScreenshot('signed-in-sheet-account.png');
      expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    } else {
      const trigger = page.getByRole('button', { name: 'Account menu' });
      await expect(trigger).toHaveText('LO');
      await expect(page.getByRole('banner')).toHaveScreenshot('signed-in-header.png');
      await trigger.click();
      const menu = page.getByRole('menu');
      await expect(menu.getByText(MEMBER.user.email)).toBeVisible();
      await expect(menu).toHaveScreenshot('signed-in-menu.png');
      expect(await seriousViolations(page, '[role="menu"]')).toEqual([]);
    }
  });
});
