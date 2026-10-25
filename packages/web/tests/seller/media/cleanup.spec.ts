import { expect, test } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { myShops, ownerWithShop, uniqueTitle } from '../cross-cutting/support';
import { scalar } from '../support/db';
import { dbOrder, dbVersion, savedGallery } from './edit-support';
import { execFileSync } from 'node:child_process';

/**
 * AI QA, area "media", pass 3: what happens to photos and galleries when a shop is deleted (map lines
 * `media.shop.deleted-cleanup`, `media.product.deleted-cleanup`). The owner starts the offboarding; the grace period is moved
 * into the past in the database; the platform's hourly purge (minute 5) deletes the shop, its products and sends the events.
 * May take up to about 65 minutes.
 */
// another agent may pause the database container for a while: a failed read counts as "not yet"
const safe = (read: () => string): string => {
  try {
    return read();
  } catch {
    return '';
  }
};
const sql = (query: string) => execFileSync('docker', ['exec', '-i', 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', query]);

test('media.shop.deleted-cleanup, media.product.deleted-cleanup: a deleted shop loses its galleries and its photos become DELETED', async ({ page }) => {
  test.info().annotations.push({ type: 'aiqa-lines', description: 'media.shop.deleted-cleanup,media.product.deleted-cleanup' });
  test.setTimeout(75 * 60_000);
  const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Gone One') }, { title: uniqueTitle('Gone Two') }]);
  const photos = [...(await savedGallery(token, shopId, productIds[0], 2)), ...(await savedGallery(token, shopId, productIds[1], 1))];
  const slug = (await myShops(token)).find((shop) => shop.id === shopId)!.slug;
  const started = await sellerCall('POST', `/api/shops/${shopId}/offboarding`, { confirmSlug: slug }, token);
  expect(started.status, JSON.stringify(started.data)).toBeLessThan(300);
  expect(scalar(`select status from "Shop" where id='${shopId}'`)).toBe('DELETING');
  sql(`update "Shop" set "purgeAt"=now()-interval '1 hour' where id='${shopId}'`);
  await expect.poll(() => safe(() => scalar(`select status from "Shop" where id='${shopId}'`)), { timeout: 70 * 60_000, intervals: [30_000], message: 'the purge job deleted the shop' }).toBe('DELETED');
  // the events are handled a moment later
  await expect
    .poll(() => scalar(`select count(*) from "ProductMedia" where "productId" in ('${productIds.join("','")}')`), { timeout: 120_000 })
    .toBe('0');
  await expect.poll(() => scalar(`select count(*) from "Media" where "shopId"='${shopId}' and status<>'DELETED'`), { timeout: 120_000 }).toBe('0');
  expect(scalar(`select count(*) from "ProductGallery" where "productId" in ('${productIds.join("','")}')`), 'gallery heads are gone with the rows').toBe('0');
  for (const id of photos) {
    expect(scalar(`select status from "Media" where id='${id}'`)).toBe('DELETED');
    expect(scalar(`select count(*) from "MediaStatusHistory" where "mediaId"='${id}' and "toStatus"='DELETED'`)).toBe('1');
    expect(scalar(`select count(*) from "Outbox" where type='media.deleted' and "aggregateId"='${id}'`), 'one media.deleted each').toBe('1');
  }
  void dbOrder;
  void dbVersion;
});
