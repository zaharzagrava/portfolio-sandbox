import { test, expect } from '@playwright/test';
import { ControlSurface, adminClient } from '../../backend/test/journeys/support/control-surface';
import { JOURNEY_PASSWORD, JourneyClient } from '../../backend/test/journeys/support/journey-client';
import { checkout, payOrder, waitBalance, waitOrderStatus, waitPaymentStatus } from '../../backend/test/journeys/support/purchase';
import { createSeller } from '../../backend/test/journeys/support/seller-fixture';
import { login, payWithSandboxCard, register, sellerMenu } from './helpers';

/**
 * J01 AS-29: the buy-to-payout path seen through the screens (W03 checkout, W04 seller dashboard). The data comes from the
 * journey support kit through the public API: a seller with its own shop and product (L-005, L-006), a second order paid
 * through the API so that the shop has money to be paid out, a weekly payout run with the clock moved and put back.
 * The buyer's purchase and everything the seller reads afterwards go through the browser.
 */
test.describe('J01 buy to payout', () => {
  test.describe.configure({ timeout: 240_000 });

  test('J01 AS-29: the buyer pays and sees the order paid without reload; the seller sees balance, paid payout, statement and CSV', async ({ browser }) => {
    const admin = await adminClient();
    const control = new ControlSurface(admin);
    const seller = await createSeller(admin, { products: [{ priceMinor: 6000, quantity: 20 }], destination: 'acct_test_ok' });
    const product = seller.products[0];

    try {
      // --- the buyer, in the browser -------------------------------------------------------------------------------------
      const buyerPage = await (await browser.newContext()).newPage();
      await buyerPage.addInitScript(() => {
        navigator.sendBeacon = () => false;
      });
      await buyerPage.route('**/api/events', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
      await register(buyerPage);
      await buyerPage.goto(`/products/${product.id}`);
      await buyerPage.getByRole('button', { name: 'Add to cart' }).click();
      await expect(buyerPage.getByText('Added to cart')).toBeVisible();
      await buyerPage.goto('/cart');
      await buyerPage.getByRole('link', { name: 'Checkout', exact: true }).first().click();
      await buyerPage.getByRole('button', { name: 'Place order' }).click();
      await expect(buyerPage).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);
      await payWithSandboxCard(buyerPage);
      // no reload: the page moves to the confirmation on its own when the payment result arrives
      await expect(buyerPage.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 45_000 });
      await expect(buyerPage).toHaveURL(/\/checkout\/success\//);

      // --- a second order through the API, so the shop's balance is above the payout minimum ---------------------------------
      const buyer = await JourneyClient.signUp('buyer');
      const { order } = await checkout(buyer, [{ product, quantity: 2 }]);
      const accepted = await payOrder(buyer, order.orderId);
      await waitPaymentStatus(buyer, (accepted.body as { paymentId: string }).paymentId, 'COMPLETED', 'H2');
      await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');
      await waitBalance(seller, (b) => b.availableMinor >= 1000 && b.source === 'read_model', 'credited in the read model');

      // --- the payout: the destination must cool (48 h), then the weekly run pays ---------------------------------------------
      await control.advance(49 * 3600);
      const job = await control.runJob('payouts.run-weekly');
      expect(job.status).toBe('SUCCEEDED');
      await expectPaidPayoutOf(seller.owner, seller.shopId);

      // --- the seller, in the browser ------------------------------------------------------------------------------------
      // The clock is still moved: the statement counts a payout only from the moment it was recorded, so after the clock is
      // put back (outer `finally`) the payout lies in the future and the month shows "Paid out €0.00" (the backend journey
      // reads it in the same way, before its rebase).
      const sellerPage = await (await browser.newContext({ acceptDownloads: true })).newPage();
      await login(sellerPage, seller.owner.email, JOURNEY_PASSWORD);
      // W04 AS-08: a single shop redirects to its overview
      await sellerPage.goto('/dashboard/seller');
      await expect(sellerPage).toHaveURL(new RegExp(`/dashboard/seller/${seller.shopId}$`));
      await (await sellerMenu(sellerPage)).getByRole('link', { name: 'Payouts' }).click();
      await expect(sellerPage.getByTestId('balance-card')).toBeVisible();
      await expect(sellerPage.getByTestId('balance-amount')).toContainText(/€\s?\d/);
      const payoutRow = sellerPage.getByTestId('payout-row');
      await expect(payoutRow).toHaveCount(1);
      await expect(payoutRow).toContainText('Paid');

      await sellerPage.goto(`/dashboard/seller/${seller.shopId}/statements`);
      const statement = sellerPage.getByTestId('statement');
      await expect(statement).toBeVisible();
      await expect(sellerPage.getByTestId('statement-gross')).toContainText(/€\s?\d/);
      await expect(sellerPage.getByTestId('statement-paid-out')).not.toContainText('€0.00');

      // the "as known on" picker: the end of today is the statement as the shop knows it now
      const gross = await sellerPage.getByTestId('statement-gross').innerText();
      await sellerPage.getByLabel('As known on').fill(new Date().toISOString().slice(0, 10));
      await expect(sellerPage.getByTestId('statement-gross')).toHaveText(gross);
      await expect(sellerPage.getByText(/As it was known on the chosen day/)).toBeVisible();

      const month = await sellerPage.getByLabel('Month').inputValue();
      const download = sellerPage.waitForEvent('download');
      await sellerPage.getByRole('link', { name: 'Download CSV' }).click();
      expect((await download).suggestedFilename()).toBe(`statement-${seller.shopId}-${month}.csv`);
    } finally {
      await control.rebase().catch(() => undefined);
      await control.restoreAll().catch(() => undefined);
    }
  });
});

async function expectPaidPayoutOf(owner: JourneyClient, shopId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const reply = await owner.get<{ items: { status: string }[] }>(`/api/shops/${shopId}/payouts`);
        return reply.status === 200 ? reply.body.items.map((p) => p.status) : [];
      },
      { timeout: 60_000 },
    )
    .toEqual(['PAID']);
}
