/** Hourly jobs (purge, shop cleanup): up to about an hour each. Skipped unless AIQA_SLOW=1. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { sellerCall } from './helpers';
import { ownerWithShop, myShops, uniqueTitle } from './seller/cross-cutting/support';
import { scalar } from './seller/support/db';
import { dbMediaStatus, greyPng, uploadReady, dbOrder, dbVersion, savedGallery } from './support/media';

test.skip(!process.env.AIQA_SLOW, 'slow: hourly jobs');

// ---- purge
{
/**
 * AI QA, area "media", pass 3: the hourly purge job (map line `media.be.job.purge`). Rows are aged in the database and the test
 * waits for the next full hour (the job runs at minute 0), so this spec may take up to about 65 minutes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s3sdk: any = createRequire(path.join(__dirname, '../../backend/package.json'))('@aws-sdk/client-s3');
const s3 = new s3sdk.S3Client({ endpoint: 'http://localhost:9100', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
const exists = (key: string) => s3.send(new s3sdk.HeadObjectCommand({ Bucket: 'marketplace-media', Key: key })).then(() => true, () => false);
// another agent may pause the database container for a while: a failed read counts as "not yet"
const safe = (read: () => string): string => {
  try {
    return read();
  } catch {
    return '';
  }
};
const sql = (query: string) => execFileSync('docker', ['exec', '-i', 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', query]);
const variantKeys = (id: string): string[] => Object.values(JSON.parse(scalar(`select variants from "Media" where id='${id}'`)) as Record<string, { key: string }>).map((v) => v.key);

test('S29 AS-53: old finished rows are removed with their files; a variant used by a live photo stays; young and live rows stay @desktop', async ({ page }) => {
  test.info().annotations.push({ type: 'aiqa-lines', description: 'media.be.job.purge' });
  test.setTimeout(75 * 60_000);
  const { shopId, token } = await ownerWithShop(page, []);
  const same = greyPng(41, 23);
  const live = await uploadReady(token, shopId, same); // the same bytes give the same variant files as `shared`
  const shared = await uploadReady(token, shopId, same);
  const lonely = await uploadReady(token, shopId, greyPng(43, 29));
  const young = await uploadReady(token, shopId, greyPng(45, 31));
  const orphanLive = await uploadReady(token, shopId, greyPng(47, 37));
  const expired = (await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token)).data.mediaId as string;
  for (const id of [shared, lonely, young]) expect((await sellerCall('DELETE', `/api/media/${id}`, undefined, token)).status).toBe(204);
  sql(`update "Media" set status='EXPIRED' where id='${expired}'`);
  const sharedKeys = variantKeys(shared);
  const lonelyKeys = variantKeys(lonely);
  const lonelyOriginal = scalar(`select "originalKey" from "Media" where id='${lonely}'`);
  expect(sharedKeys, 'identical bytes share the variant files').toEqual(variantKeys(live));
  expect(await exists(lonelyKeys[0])).toBe(true);
  // age: 40 days (first in the job's queue) for shared, lonely, expired; today for `young`; a READY row of 40 days stays
  sql(`update "Media" set "updatedAt"=now()-interval '40 days' where id in ('${shared}','${lonely}','${expired}','${orphanLive}')`);
  await expect.poll(() => safe(() => scalar(`select count(*) from "Media" where id in ('${shared}','${lonely}','${expired}')`)), { timeout: 70 * 60_000, intervals: [30_000], message: 'the purge job ran' }).toBe('0');
  expect(scalar(`select count(*) from "MediaStatusHistory" where "mediaId" in ('${shared}','${lonely}','${expired}')`), 'history rows go with the photo').toBe('0');
  expect(await exists(lonelyOriginal), 'the original of a purged photo is deleted').toBe(false);
  for (const key of lonelyKeys) expect(await exists(key), 'its own variants are deleted').toBe(false);
  for (const key of sharedKeys) expect(await exists(key), 'a variant that a live photo uses stays').toBe(true);
  expect(dbMediaStatus(live)).toBe('READY');
  expect(dbMediaStatus(young), 'deleted today: not purged').toBe('DELETED');
  expect(dbMediaStatus(orphanLive), 'a READY photo is never purged').toBe('READY');
});
}

// ---- cleanup
{
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

test('S29 AS-40: a deleted shop loses its galleries and its photos become DELETED @desktop', async ({ page }) => {
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
}
