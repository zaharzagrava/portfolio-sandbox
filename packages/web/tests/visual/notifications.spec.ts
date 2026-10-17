import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousViolations } from './axe';
import { register } from '../helpers';

/**
 * VN rows of W03 (AS-65, AS-69, AS-74): the notification panel at the phone (390 x 844) and desktop (1280 x 800) widths,
 * against the real dev stack with a freshly registered member. The inbox read is answered by a route where a state must be
 * forced (empty, error, a long list); the layout is what is measured, not the backend.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const manyItems = Array.from({ length: 20 }, (_, n) => ({
  id: id(n + 1),
  type: 'order.confirmed',
  category: 'orders',
  title: n === 0 ? 'A very long notification title that has to wrap onto several lines without ever causing a horizontal scrollbar' : `Order update ${n + 1}`,
  body: 'We received your payment. Your order is being prepared and you will hear from us when it ships.',
  link: `/orders/${id(n + 1)}`,
  read: n > 3,
  createdAt: '2026-10-10T10:00:00.000Z',
}));

async function openPanel(page: Page, options: { unread?: number } = {}) {
  await register(page);
  // The welcome item is created asynchronously after sign-up: wait for the badge so the first read of the inbox has it.
  if (options.unread) await expect(page.getByRole('button', { name: `Notifications, ${options.unread} unread` })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await expect(panel).toBeVisible();
  // The panel zooms in: measure it once the animation has ended.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  return panel;
}

// The unread count is pinned with the list: a fresh member's welcome item arrives asynchronously, and "Mark all as read" shows
// only while the count is above zero, so an unpinned count changes the height of the panel from run to run.
async function stubInbox(page: Page, respond: Parameters<Page['route']>[1], unread = 0) {
  // The live stream would prepend the welcome item to a list that is pinned here, at a moment that changes from run to run.
  // The stream stays up (an offline stream shows its own banner); only its `notification` events are not delivered.
  await page.addInitScript(() => {
    const add = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function (this: EventSource, type: string, ...rest: unknown[]) {
      if (type === 'notification') return;
      return (add as (...args: unknown[]) => void).call(this, type, ...rest);
    } as typeof EventSource.prototype.addEventListener;
  });
  await page.route('**/api/notifications?*', respond);
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ status: 200, contentType: 'application/json', json: { unread } }));
}

test.describe('Notifications layout', () => {
  test('open', async ({ page }) => {
    const panel = await openPanel(page, { unread: 1 });
    await expect(panel.getByText('Welcome aboard')).toBeVisible();
    await expectNoSeriousViolations(page);
    // The time and the account's own text move between runs: the screenshot masks the time.
    await expect(panel).toHaveScreenshot('open.png', { mask: [panel.locator('time')] });
  });

  test('empty', async ({ page }) => {
    await stubInbox(page, (route) => route.fulfill({ status: 200, contentType: 'application/json', json: { items: [], nextCursor: null } }), 0);
    const panel = await openPanel(page);
    await expect(panel.getByText("You're all caught up.")).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(panel).toHaveScreenshot('empty.png');
  });

  test('error', async ({ page }) => {
    await stubInbox(page, (route) => route.fulfill({ status: 500, contentType: 'application/problem+json', json: { status: 500, code: 'internal_error' } }));
    const panel = await openPanel(page);
    await expect(panel.getByText("We couldn't load notifications.")).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(panel).toHaveScreenshot('error.png');
  });

  test('layout: width of the panel, internal scroll, nothing sideways', async ({ page }) => {
    await stubInbox(page, (route) => route.fulfill({ status: 200, contentType: 'application/json', json: { items: manyItems, nextCursor: 'more' } }), 4);
    const panel = await openPanel(page);
    await expect(panel.getByRole('listitem')).toHaveCount(20);
    const viewport = page.viewportSize() as { width: number; height: number };
    const box = (await panel.boundingBox()) as { x: number; y: number; width: number; height: number };
    if (viewport.width <= 640) {
      // As wide as the viewport minus the 16 px gutters.
      expect(Math.round(box.width)).toBe(viewport.width - 32);
    } else {
      expect(Math.round(box.width)).toBe(384);
    }
    // At most 70% of the viewport tall, and the list scrolls inside the panel.
    expect(box.height).toBeLessThanOrEqual(viewport.height * 0.7 + 1);
    const scrolls = await panel.evaluate((node) => [...node.querySelectorAll('*')].some((el) => el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY === 'auto'));
    expect(scrolls).toBe(true);
    // No sideways scroll in the panel or the page.
    expect(await panel.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await expectNoSeriousViolations(page);
    await expect(panel).toHaveScreenshot('layout.png', { mask: [panel.locator('time')] });
  });

  test('layout: a 320 px phone', async ({ page }) => {
    await stubInbox(page, (route) => route.fulfill({ status: 200, contentType: 'application/json', json: { items: manyItems, nextCursor: null } }), 4);
    await page.setViewportSize({ width: 320, height: 700 });
    const panel = await openPanel(page);
    await expect(panel.getByRole('listitem')).toHaveCount(20);
    expect(await panel.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0);
    const box = (await panel.boundingBox()) as { x: number; width: number };
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  });
});
