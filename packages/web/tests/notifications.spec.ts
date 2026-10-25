import { createHmac } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { bellCount, createIsolatedProduct, payWithSandboxCard, register } from './helpers';

/**
 * S28 journeys against the real dev stack: the bell (live item, Mark all read), the preferences screen (a toggle that
 * survives a reload, a phone and its code) and the unsubscribe page (describe, then confirm).
 * A new account gets the `account.welcome` notification (in-app item) from the registration event.
 */

const bell = (page: Page, name: string | RegExp) => page.getByRole('button', { name });

test.describe('Notification bell @desktop', () => {
  test('a new account gets a live item, and Mark all read takes the badge away', async ({ page }) => {
    await register(page);
    await expect(bell(page, 'Notifications, 1 unread')).toBeVisible({ timeout: 20_000 });

    await bell(page, 'Notifications, 1 unread').click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Welcome aboard' })).toBeVisible();
    await page.getByRole('button', { name: 'Mark all as read' }).click();

    await expect(bell(page, 'Notifications')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
    await expect(page.getByRole('listitem').filter({ hasText: 'Welcome aboard' }).getByText('Unread')).toHaveCount(0);

    // The server agrees: a reload shows no badge.
    await page.reload();
    await expect(bell(page, 'Notifications')).toBeVisible();
    await expect(bell(page, /unread/)).toHaveCount(0);
  });
});

test.describe('Notifications after an order (W03 JN-1) @desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      navigator.sendBeacon = () => false;
    });
    await page.route('**/api/events', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
  });

  async function paidOrder(page: Page) {
    const { id } = await createIsolatedProduct({ quantity: 200 });
    await register(page);
    // The welcome item is read first, so the count below is about the order.
    await expect(bell(page, 'Notifications, 1 unread')).toBeVisible({ timeout: 20_000 });
    await bell(page, 'Notifications, 1 unread').click();
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => bellCount(page)).toBe(0);
    await page.goto(`/products/${id}`);
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to cart')).toBeVisible();
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);
    const orderId = page.url().split('/').pop() as string;
    await payWithSandboxCard(page);
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 60_000 });
    return orderId;
  }

  test('JN-1 pay: the order item reaches the bell, leads to the order, and following it lowers the count', async ({ page }) => {
    test.setTimeout(150_000); // the dev stack settles the payment through its fake provider
    const orderId = await paidOrder(page);
    // The page is reloaded between reads: the count is what the server says (the live push is the fixme below).
    await expect
      .poll(async () => {
        await page.reload();
        await page.waitForLoadState('networkidle');
        return bellCount(page);
      }, { timeout: 60_000 })
      .toBeGreaterThan(0);
    const before = await bellCount(page);
    await bell(page, /^Notifications, \d+ unread$/).click();
    const item = page.getByRole('link').filter({ hasText: 'Order confirmed' }).first();
    await expect(item).toHaveAttribute('href', new RegExp(`/orders/${orderId}`));
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
    await expect.poll(() => bellCount(page)).toBeLessThan(before);
  });

  // Blocked, not weakened: through the Next dev server the stream answers 200 but sends no byte (not even a heartbeat) for
  // 20 s while the order is paid or cancelled, so the push cannot be observed on this stack (questions.md, UNVERIFIED.md).
  test.fixme('JN-1 live: the bell count rises without a reload when the order is paid', async ({ page }) => {
    await paidOrder(page);
    await expect.poll(() => bellCount(page), { timeout: 30_000 }).toBeGreaterThan(0);
  });
});

test.describe('Notification preferences @desktop', () => {
  test('a switch is saved and survives a reload; locked cells and text messages are guarded', async ({ page }) => {
    await register(page);
    await page.goto('/account/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();

    const ordersEmail = page.getByRole('switch', { name: 'Orders: Email' });
    await expect(ordersEmail).toBeChecked();
    await ordersEmail.click();
    await expect(ordersEmail).not.toBeChecked();
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Orders: Email' })).not.toBeChecked();

    await expect(page.getByRole('switch', { name: 'Security: Email (required)' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Orders: Text message' })).toBeDisabled();
  });

  test('the old link /settings/notifications lands on the screen', async ({ page }) => {
    await register(page);
    await page.goto('/settings/notifications');
    await expect(page).toHaveURL(/\/account\/notifications$/);
  });

  test('a phone is added (masked from then on) and a wrong code is refused', async ({ page }) => {
    await register(page);
    await page.goto('/account/notifications');
    const phone = `+38050${String(Date.now()).slice(-7)}`;
    await page.getByRole('textbox', { name: 'Phone number' }).fill(phone);
    await page.getByRole('button', { name: 'Send code' }).click();
    const current = page.getByText(/^Current number:/);
    await expect(current).toBeVisible();
    await expect(current).not.toContainText(phone);
    await expect(page.getByText('not verified')).toBeVisible();

    await page.getByLabel('Verification code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'That code is not right.' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Orders: Text message' })).toBeDisabled();
  });

  test('quiet hours need both ends', async ({ page }) => {
    await register(page);
    await page.goto('/account/notifications');
    const form = page.getByRole('form', { name: 'Quiet hours, time zone and language' });
    await form.getByLabel('Quiet hours start').fill('22:00');
    await form.getByRole('button', { name: 'Save settings' }).click();
    await expect(form.getByRole('alert')).toHaveText('Set both the start and the end of quiet hours, or clear both.');
    await form.getByLabel('Quiet hours end').fill('07:30');
    await form.getByRole('button', { name: 'Save settings' }).click();
    await expect(form.getByText('Settings saved.')).toBeVisible();
  });
});

/** The backend's `signUnsubscribe` (token = base64url(userId|category|v1).hmac); the key is the stack's NOTIFICATION_SECRET. */
function unsubscribeToken(userId: string, category: string, secret: string): string {
  const payload = Buffer.from(`${userId}|${category}|v1`).toString('base64url');
  const mac = createHmac('sha256', secret).update(`unsubscribe:${payload}`).digest('base64url').slice(0, 22);
  return `${payload}.${mac}`;
}

test.describe('Unsubscribe @desktop', () => {
  test('a link that is not valid shows the friendly state and no button', async ({ page }) => {
    // `main` only: Next's own route announcer is also a `role="alert"` once the page has hydrated.
    const alert = page.getByRole('main').getByRole('alert');
    await page.goto('/unsubscribe?token=not-a-real-token');
    await expect(alert).toContainText('This unsubscribe link is not valid.');
    await expect(page.getByRole('button', { name: 'Unsubscribe' })).toHaveCount(0);
    await page.goto('/unsubscribe');
    await expect(alert).toContainText('This unsubscribe link is not valid.');
  });

  test('opening the link only describes the change; the button performs it', async ({ page }) => {
    test.skip(!process.env.NOTIFICATION_SECRET, 'Needs the stack\'s NOTIFICATION_SECRET to sign an unsubscribe link (the dev mailbox does not expose it).');
    await register(page);
    const session = await page.request.get('/api/bff/session');
    const { user } = (await session.json()) as { user: { id: string } };
    const token = unsubscribeToken(user.id, 'orders', process.env.NOTIFICATION_SECRET as string);

    // A visitor with no session, as from an e-mail client.
    await page.context().clearCookies();
    await page.goto(`/unsubscribe?token=${encodeURIComponent(token)}`);
    await expect(page.getByText(/Stop receiving/)).toContainText('orders');
    await expect(page.locator('body')).not.toContainText(token);

    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/notifications/unsubscribe')) posts.push(request.url());
    });
    expect(posts).toHaveLength(0);
    await page.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(page.getByRole('status')).toContainText('You are unsubscribed from orders emails.');
    expect(posts).toHaveLength(1);
  });
});
