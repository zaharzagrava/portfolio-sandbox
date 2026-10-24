import { test, expect } from '@playwright/test';
import { register, shopPath } from './helpers';
import { openShopByApi } from './seller-setup';

/**
 * Bulk catalog import happy path (S07 SC-008, journey J04; W04 US10): choose a CSV, the parts upload to the addresses of the
 * start answer, the progress follows `import:<importId>`, the import ends Done and the error-report link downloads the
 * refused rows. The page is `/dashboard/seller/{shopId}/imports`.
 */
test.describe('Seller bulk import', () => {
  test('a seller imports a CSV, watches the progress and downloads the report of the refused rows', async ({ page }) => {
    const member = await register(page);
    const { shopId } = await openShopByApi(member);

    await page.goto(shopPath(shopId, 'imports'));
    // a file chosen before React attaches its handlers is never seen (the Start button stays disabled on a loaded machine)
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="import-file"]');
      return !!input && Object.keys(input).some((key) => key.startsWith('__reactProps'));
    });
    const rows = ['sku,title,description,price,stock,category,brand'];
    for (let i = 1; i <= 20; i++) rows.push(`E2E-${i},Item ${i},Generated,${i % 5 === 0 ? 'abc' : '12.50'},3,kitchen,ClayWorks`);
    await page.getByTestId('import-file').setInputFiles({
      name: 'catalog.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(rows.join('\n') + '\n'),
    });
    await page.getByRole('button', { name: 'Start import' }).click();

    await expect(page.getByTestId('import-progress')).toBeVisible();
    await expect(page.getByTestId('import-status')).toHaveText('Done', { timeout: 60_000 });
    await expect(page.getByTestId('import-rows-failed')).toHaveText('4');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download error report' }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });
});
