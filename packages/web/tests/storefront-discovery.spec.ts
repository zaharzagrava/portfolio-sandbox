import { test, expect } from '@playwright/test';
import { createPickupSeed, FAKE_LOCATION, productWithRecommendations } from './helpers';

/** Journeys of the storefront that cross capabilities (S19 pickup, S34 recommendations). */
test.describe('Storefront discovery @desktop', () => {
  test.describe('pickup', () => {
    test.use({ geolocation: FAKE_LOCATION, permissions: ['geolocation'] });

    test('search near me', async ({ page }) => {
      const seed = await createPickupSeed();
      test.fixme(!seed, 'the pickup seed (seller API: point and stock) did not reach the pickup index (questions.md Q-W02-6)');
      await page.goto(`/search?q=${encodeURIComponent(seed!.title)}`);
      await page.getByRole('switch', { name: 'Available for pickup near me' }).click();
      await expect(page).toHaveURL(/near=1/);
      await expect(page).not.toHaveURL(/[?&](lat|lng)=|52\.5/);
      await expect(page.getByRole('heading', { level: 1, name: 'Pickup near you' })).toBeVisible();
      const card = page.getByTestId('product-card').filter({ hasText: seed!.title });
      await expect(card).toContainText(`away · ${seed!.pointName} · 7 available`);
      await page.getByRole('combobox', { name: 'Radius' }).selectOption('10');
      await expect(page).toHaveURL(/radiusKm=10/);
      await expect(card).toBeVisible();
    });

    test('pickup near me', async ({ page }) => {
      const seed = await createPickupSeed();
      test.fixme(!seed, 'the pickup seed did not reach the pickup index (questions.md Q-W02-6)');
      await page.goto(`/products/${seed!.productId}?tab=pickup`);
      const panel = page.getByRole('tabpanel', { name: 'Pickup near me' });
      await panel.getByRole('button', { name: 'Use my location' }).click();
      await expect(panel.getByRole('list', { name: 'Pickup points' })).toContainText(seed!.pointName);
      await panel.getByRole('combobox', { name: 'Radius' }).selectOption('10');
      await expect(panel.getByRole('list', { name: 'Pickup points' })).toContainText(seed!.pointName);
    });

    test('map clusters', async ({ page }) => {
      const seed = await createPickupSeed();
      test.fixme(!seed, 'the pickup seed did not reach the pickup index (questions.md Q-W02-6)');
      const clusters = page.waitForResponse((res) => res.url().includes('/pickup-points/clusters') && res.ok());
      await page.goto(`/products/${seed!.productId}?tab=pickup`);
      const panel = page.getByRole('tabpanel', { name: 'Pickup near me' });
      await panel.getByRole('button', { name: 'Use my location' }).click();
      await panel.getByRole('button', { name: 'Show map' }).click();
      const body = (await (await clusters).json()) as { cells: unknown[]; truncated: boolean };
      expect(Array.isArray(body.cells)).toBe(true);
      expect(typeof body.truncated).toBe('boolean');
      await expect(page.getByRole('region', { name: 'Pickup map' }).or(page.getByRole('dialog', { name: 'Pickup map' }))).toBeVisible();
    });
  });

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
