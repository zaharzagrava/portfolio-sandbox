import { test, expect } from '@playwright/test';
import { createIsolatedProduct, register, sellerCall, sellerSession } from './helpers';

/**
 * "Ask this product" on the product page (S47 AS-01, W02). The seller side (documents, ingestion) runs through the real
 * API; the buyer side through the UI. Each run creates its own product and document (L-006) and waits with the runner's
 * timeouts (L-007). Answers come from the dev stack's scripted model: the journey proves the stream reaches the page and
 * the sources are the document's, not the wording of the answer.
 */
test.describe('Ask this product and help documents', () => {
  test('a buyer asks on the product page; the answer streams in with the source chips of the manual', async ({ page }) => {
    const product = await createIsolatedProduct();
    const session = await sellerSession();
    const created = await sellerCall(
      'POST',
      `/api/shops/${session.shopId}/knowledge/documents`,
      {
        title: 'Lantern manual',
        visibility: 'PUBLIC',
        productId: product.id,
        markdown: '# Battery\nThe lantern battery lasts 40 hours on one charge.',
      },
      session.token,
    );
    expect(created.status).toBe(201);
    const documentId: string = created.data.document.id;
    await expect
      .poll(
        async () => (await sellerCall('GET', `/api/shops/${session.shopId}/knowledge/documents/${documentId}`, undefined, session.token)).data?.status,
        { timeout: 60_000, message: 'the document is not indexed - is the worker running (dev-monolith)?' },
      )
      .toBe('READY');

    await register(page);
    await page.goto(`/products/${product.id}`);
    await page.getByRole('tab', { name: 'Ask about this product' }).click();
    await page.getByLabel('Question').fill('Does the lantern battery last 40 hours?');
    await page.getByRole('button', { name: 'Ask' }).click();

    await expect(page.getByTestId('ask-answer')).toBeVisible();
    await expect(page.getByTestId('ask-source').first()).toContainText('Lantern manual > Battery');
  });

  // W04 owns the seller's document screens and its source list does not name S47 yet (gaps.md, Sibling-spec follow-ups).
  test.skip('seller uploads a PDF manual on the dashboard and sees READY (pending W04 owning the screen)', async () => {});
  test.skip('seller asks the help center and sees a cited answer (pending W04 owning the screen)', async () => {});
});
