import { expect, test } from '@playwright/test';
import { payWithSandboxCard, register, seedProduct, shopPath } from './helpers';
import { openShopByApi } from './seller-setup';

/** W04 AS-19 (and S40 AS-50): a paid order of the shop moves the live numbers without a reload. Own member, shop and product. */
test.describe('Seller live numbers @desktop', () => {
  test.describe.configure({ timeout: 120_000 });

  test('W04 AS-19: a sandbox-paid order moves Orders and Revenue of the last 60 seconds within 2 seconds', async ({ browser }) => {
    const sellerPage = await (await browser.newContext()).newPage();
    const seller = await register(sellerPage);
    const { shopId } = await openShopByApi(seller);
    const productId = await seedProduct(shopId, { priceMinor: 6000, quantity: 5 }, seller);

    await sellerPage.goto(shopPath(shopId));
    const live = sellerPage.getByRole('region', { name: 'Last 60 seconds' });
    await expect(live.getByRole('status')).toHaveText('Live', { timeout: 15_000 });
    await expect(live.getByText('Orders', { exact: true }).locator('..')).toContainText('0');

    // a different member buys the product and pays with the sandbox card
    const buyerPage = await (await browser.newContext()).newPage();
    await buyerPage.addInitScript(() => {
      navigator.sendBeacon = () => false;
    });
    await register(buyerPage);
    await buyerPage.goto(`/products/${productId}`);
    await buyerPage.getByRole('button', { name: 'Add to cart' }).click();
    await expect(buyerPage.getByText('Added to cart')).toBeVisible();
    await buyerPage.goto('/cart');
    await buyerPage.getByRole('link', { name: 'Checkout', exact: true }).first().click();
    await buyerPage.getByRole('button', { name: 'Place order' }).click();
    await expect(buyerPage).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);
    await payWithSandboxCard(buyerPage);
    await expect(buyerPage.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 45_000 });

    // the seller's page, not reloaded, shows the order. The 2 s of AS-19 start when the order reaches the live counters
    // (the orders.events projection, which lags behind "Order confirmed" on a loaded machine); from then on one frame
    // carries both numbers, so Revenue must follow within 2 s.
    await expect(live.getByText('Orders', { exact: true }).locator('..')).toContainText('1', { timeout: 20_000 });
    await expect(live.getByText('Revenue', { exact: true }).locator('..')).toContainText(/60[.,]00/, { timeout: 2_000 });
    await expect(live.getByRole('status')).toHaveText('Live');
  });
});
