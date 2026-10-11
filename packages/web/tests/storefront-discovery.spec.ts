import { test, expect } from '@playwright/test';
import { productWithRecommendations } from './helpers';

/** Journeys of the storefront that cross capabilities (S19 pickup, S34 recommendations); the pickup ones come with US4/US6. */
test.describe('Storefront discovery', () => {
  test('product page shows frequently bought together', async ({ page, request }) => {
    const found = await productWithRecommendations(request);
    test.fixme(!found, 'S34 dataset D (bought together) is not seeded in the dev stack (questions.md Q-W02-3)');
    await page.goto(`/products/${found!.id}`);
    const rail = page.getByRole('region', { name: 'Frequently bought together' });
    await expect(rail.getByTestId('rail-card')).toHaveCount(found!.titles.length);
    for (const [index, title] of found!.titles.entries()) await expect(rail.getByTestId('rail-card').nth(index)).toContainText(title);
    await rail.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  });
});
