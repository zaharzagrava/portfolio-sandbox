import { expect, test } from '@playwright/test';

/**
 * J05 AS-34 (S26 asks J05 for the UI path): a signed-in follower presses Follow on a shop page, the shop publishes a product
 * and the home feed shows a card with the product title and price that links to it.
 *
 * `test.fixme` until a web capability owns the follow button and the home feed (J05 spec, Screens; gaps.md G-19). The API
 * side of the same path is proven by `J05 AS-01` in `test/journeys/engagement-loop.journey-spec.ts`.
 */
test.describe('Engagement loop', () => {
  test.fixme('J05 AS-34: follow a shop, see its new product in the home feed', async ({
    page,
  }) => {
    await page.goto('/feed');
    const card = page.getByRole('article').filter({ hasText: 'New product' });
    await expect(card.getByRole('link')).toBeVisible();
  });
});
