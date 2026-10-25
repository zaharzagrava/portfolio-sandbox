import { expect, test } from '@playwright/test';

/**
 * JA (W02 AS-66, AS-72; S36 FR-020): with `STOREFRONT_ADS_ENABLED=true` and an active campaign, `/search` shows up to three
 * cards labelled "Sponsored" above the results; each link uses the server's `clickUrl` as given and carries
 * `rel="sponsored nofollow"`.
 *
 * `test.fixme` until the deploy turns `STOREFRONT_ADS_ENABLED` on and S36's `GET /api/ads/sponsored` controller exists
 * (backend-endpoints.md: "not built"; gaps.md, Sibling-spec follow-ups). `components/search/sponsored-slot.test.tsx`
 * covers the behaviour against the contract meanwhile.
 */
test.describe('Sponsored listing @desktop', () => {
  test.fixme('sponsored cards above results', async ({ page }) => {
    await page.goto('/search');
    const slot = page.getByRole('region', { name: 'Sponsored' });
    await expect(slot).toBeVisible();
    const links = slot.getByRole('link');
    expect(await links.count()).toBeLessThanOrEqual(3);
    await expect(links.first()).toHaveAttribute('rel', 'sponsored nofollow');
    await expect(links.first()).toHaveAttribute('href', /^(\/api\/ads\/click\/|https:\/\/)/);

    // Not on a later page.
    await page.goto('/search?cursor=x');
    await expect(page.getByRole('region', { name: 'Sponsored' })).toHaveCount(0);
  });
});
