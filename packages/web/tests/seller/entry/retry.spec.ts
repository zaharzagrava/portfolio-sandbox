import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { register, sellerCall } from '../../helpers';
import { tokenOf } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { covers } from './support';

/**
 * AI QA, area "entry", pass 3: the picker page when the shop list cannot be read (a stored plan the web cannot parse makes the page fail the
 * way a failed list read does; a real 5xx cannot be made without stopping a service).
 */

const HOME = '/dashboard/seller';
const sql = (statement: string) => execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', statement]);

test('entry.index.error-boundary: a failing shop list gives the generic error page with a reference and Try again, no technical words; Try again works once the row is repaired', async ({ page }) => {
  covers('entry.index.error-boundary');
  const member = await register(page);
  await openShopByApi(member, 'Aiqa Err One');
  const bad = await openShopByApi(member, 'Aiqa Err Two');
  sql(`update "Shop" set plan='AIQA_BROKEN' where id='${bad.shopId}'`);
  try {
    const answer = await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf({ email: member.email }));
    // The API itself answers 200 with the odd plan; it is the web server that cannot read it (same error path as a 5xx: any non-401 failure).
    expect(answer.status).toBe(200);
    expect(answer.data.items.map((item: { plan: string }) => item.plan)).toContain('AIQA_BROKEN');
    await page.goto(HOME);
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).toMatch(/Reference:\s*\S+/);
    expect(text).not.toMatch(/shops_unavailable|AIQA_BROKEN|Error:|stack|at \w+\.\w+ \(|plan/i);
    await expect(page.getByRole('list', { name: 'Your shops' })).toHaveCount(0);
    sql(`update "Shop" set plan='STARTER' where id='${bad.shopId}'`);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(2);
  } finally {
    sql(`update "Shop" set plan='STARTER' where id='${bad.shopId}'`);
  }
});
