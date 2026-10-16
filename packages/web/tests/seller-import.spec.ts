import { test, expect } from '@playwright/test';
import { register } from './helpers';

/**
 * Bulk catalog import happy path (S07 SC-008, journey J04): choose a CSV, parts upload, progress bar, DONE, the error
 * report link downloads.
 *
 * BLOCKED: the seller import page (W04) does not exist in `packages/web` yet, so there is nothing to drive. The test is
 * declared `fixme` and therefore reported as skipped, never as passed; the SC-008 row stays `not run` in
 * `specs/UNVERIFIED.md`. When W04 ships, remove the `fixme` line: the steps below are the contract it must meet
 * (subscribe to `import:<importId>`, start with an `Idempotency-Key` of 8+ characters, parts from the start response).
 */
test.describe('Seller bulk import', () => {
  test.fixme(true, 'blocked: W04 (the seller import page) is not built; SC-008 stays unverified');

  test('a seller imports a CSV, watches the progress and downloads the report of the refused rows', async ({ page }) => {
    await register(page);
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Start selling' }).click();
    await page.getByLabel('Shop name').fill(`E2E Import Shop ${Date.now()}`);
    await page.getByRole('button', { name: 'Open shop' }).click();

    await page.getByRole('link', { name: 'Import' }).first().click();
    const rows = ['sku,title,description,price,stock,category,brand'];
    for (let i = 1; i <= 20; i++)
      rows.push(`E2E-${i},Item ${i},Generated,${i % 5 === 0 ? 'abc' : '12.50'},3,kitchen,ClayWorks`);
    await page.getByTestId('import-file').setInputFiles({
      name: 'catalog.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(rows.join('\n') + '\n'),
    });
    await page.getByRole('button', { name: 'Start import' }).click();

    await expect(page.getByTestId('import-progress')).toBeVisible();
    await expect(page.getByTestId('import-status')).toHaveText('DONE', { timeout: 60_000 });
    await expect(page.getByTestId('import-rows-failed')).toHaveText('4');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Download error report' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });
});
