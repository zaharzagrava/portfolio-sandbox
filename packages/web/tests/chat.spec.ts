import { test, expect } from '@playwright/test';
import { SEED, createIsolatedProduct, login, register } from './helpers';

/** SD-14 product chat over HTTP (send + cursor sync): a buyer asks, the seller answers. */
test.describe('Product chat', () => {
  test('buyer and seller exchange messages on a product chat', async ({ browser }) => {
    // A product of its own: the desktop and mobile runs of this test run at the same time and would otherwise open the same chat together.
    const { id, title } = await createIsolatedProduct();
    const sellerContext = await browser.newContext();
    const buyerContext = await browser.newContext();
    const seller = await sellerContext.newPage();
    const buyer = await buyerContext.newPage();

    // The seller opens (or creates) the product's chat.
    await login(seller, SEED.seller, SEED.password, `/chat?product=${id}`);
    await expect(seller.getByTestId('chat-title')).toHaveText(title, { timeout: 20_000 }); // the channel is created on first open; slower under parallel load

    // A buyer joins from the product page and asks.
    await register(buyer);
    await buyer.goto(`/products/${id}`);
    await buyer.getByRole('link', { name: 'Chat with seller' }).click();
    await expect(buyer.getByTestId('chat-title')).toHaveText(title);
    const question = `Is the chair still available? ${Date.now()}`;
    await buyer.getByLabel('Message').fill(question);
    await buyer.getByRole('button', { name: 'Send' }).click();
    await expect(buyer.getByTestId('chat-message').filter({ hasText: question })).toContainText('You');

    // The seller's page picks it up on the next sync and replies.
    await expect(seller.getByTestId('chat-message').filter({ hasText: question })).toBeVisible({ timeout: 10_000 });
    const answer = `Yes, ships tomorrow ${Date.now()}`;
    await seller.getByLabel('Message').fill(answer);
    await seller.getByRole('button', { name: 'Send' }).click();
    await expect(buyer.getByTestId('chat-message').filter({ hasText: answer })).toContainText('Seller', { timeout: 10_000 });

    await sellerContext.close();
    await buyerContext.close();
  });
});
