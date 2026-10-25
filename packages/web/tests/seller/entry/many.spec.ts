import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { register, sellerCall } from '../../helpers';
import { sellerMenu } from '../../helpers';
import { tokenOf } from '../cross-cutting/support';
import { scalar, userId } from '../support/db';
import { covers, ownerByApi } from './support';

/**
 * AI QA, area "entry", pass 2, section "more than one page of shops": 51 memberships for one member (six owners with nine shops
 * each, the member added as VIEWER by SQL because the real route to a membership is one invitation mail per shop), the picker's
 * two pages and the shop frame for a shop that is not in the first 50.
 */

const HOME = '/dashboard/seller';

test('entry.picker.next-page entry.picker.page-size-50 entry.frame.current-shop-not-in-first-50: 51 shops make two pages with no gap or overlap; the shop on page 2 still heads the switcher', async ({ page }) => {
  covers('entry.picker.next-page', 'entry.picker.page-size-50', 'entry.frame.current-shop-not-in-first-50');
  test.setTimeout(240_000);
  const member = await register(page);
  const memberId = userId(member.email);
  const shopIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const { owner, shopId } = await ownerByApi();
    shopIds.push(shopId);
    const token = await tokenOf(owner);
    for (let n = 0; n < 8; n++) {
      const made = await sellerCall('POST', '/api/shops', { name: `Many ${i}-${n}`, slug: `aiqa-many-${Date.now().toString(36)}-${i}-${n}-${Math.floor(Math.random() * 1e4).toString(36)}` }, token);
      expect(made.status).toBe(201);
      shopIds.push(made.data.id as string);
    }
  }
  expect(shopIds).toHaveLength(54);
  const values = shopIds.slice(0, 51).map((id, index) => `('${id}','${memberId}','VIEWER','invite', now() + interval '${index} milliseconds')`).join(',');
  execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', `insert into "ShopMembership"("shopId","userId",role,source,"createdAt") values ${values}`]);
  expect(scalar(`select count(*) from "ShopMembership" where "userId"='${memberId}'`)).toBe('51');

  // The API: 50, then 1, no overlap, nothing missing.
  const token = await tokenOf(member);
  const one = (await sellerCall('GET', '/api/shops/mine?limit=50', undefined, token)).data as { items: { id: string }[]; nextCursor: string | null };
  expect(one.items).toHaveLength(50);
  expect(one.nextCursor).toBeTruthy();
  const two = (await sellerCall('GET', `/api/shops/mine?limit=50&cursor=${encodeURIComponent(one.nextCursor!)}`, undefined, token)).data as { items: { id: string }[]; nextCursor: string | null };
  expect(two.items).toHaveLength(1);
  expect(two.nextCursor).toBeNull();
  expect(new Set([...one.items, ...two.items].map((s) => s.id))).toEqual(new Set(shopIds.slice(0, 51)));

  // The page: 50 rows and "Next page"; page 2 has the last row, "First page" and no "Next page".
  await page.goto(HOME);
  const list = page.getByRole('list', { name: 'Your shops' });
  await expect(list.getByRole('listitem')).toHaveCount(50);
  const next = page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Next page' });
  await expect(next).toHaveAttribute('href', `${HOME}?cursor=${encodeURIComponent(one.nextCursor!)}`);
  await expect(page.getByRole('link', { name: 'First page' })).toHaveCount(0);
  const firstHrefs = await list.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  await next.click();
  await expect(page).toHaveURL(new RegExp(`\\?cursor=`));
  await expect(list.getByRole('listitem')).toHaveCount(1);
  const lastHref = await list.getByRole('link').first().getAttribute('href');
  expect(firstHrefs).not.toContain(lastHref);
  expect(`${HOME}/${two.items[0]!.id}`).toBe(lastHref);
  await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
  await page.getByRole('link', { name: 'First page' }).click();
  await expect(page).toHaveURL(HOME);
  await expect(list.getByRole('listitem')).toHaveCount(50);

  // The frame: the shop that is not in the first page heads the switcher and is marked current.
  await page.goto(`${HOME}/${two.items[0]!.id}`);
  const menu = await sellerMenu(page);
  const switcher = menu.getByRole('button').first();
  await expect(switcher).toHaveText(/Many|E2E Shop/);
  await switcher.click();
  const options = menu.getByRole('list', { name: 'Your shops' }).getByRole('listitem');
  await expect(options).toHaveCount(50);
  await expect(options.first().getByRole('link')).toHaveAttribute('aria-current', 'true');
  await expect(options.first()).toContainText('Current');
  await expect(options.first().getByRole('link')).toHaveAttribute('href', `${HOME}/${two.items[0]!.id}`);
  // "All your shops" leads to the picker's first page or to the next one.
  await expect(menu.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', /^\/dashboard\/seller(\?cursor=.+)?$/);
});
