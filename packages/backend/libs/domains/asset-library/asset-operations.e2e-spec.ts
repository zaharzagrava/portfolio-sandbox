import { v7 as uuidv7 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { AssetsJobs } from './infra/assets.jobs';
import { chunkKey } from './infra/chunk-store';
import {
  createAssetApp,
  type AssetTestApp,
  type Seller,
} from './testing/asset-client';
import { deliver, paidEvent, paidPayload } from './testing/events';

const DAY = 86_400_000;
const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Asset library: metrics, logs and scheduled jobs', () => {
  let t: AssetTestApp;
  let jobs: AssetsJobs;
  let next = 1;
  beforeAll(async () => {
    t = await createAssetApp();
    jobs = t.app.get(AssetsJobs, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    t.store.heal();
    t.hub.mode = 'ok';
  });

  const address = () => `203.0.113.${100 + (next++ % 150)}`;
  const journalSeqs = async (shopId: string) =>
    (
      await t.rows<{ seq: string }>(
        `SELECT "seq" FROM "AssetChange" WHERE "shopId" = :shopId ORDER BY "seq"`,
        { shopId },
      )
    ).map((r) => Number(r.seq));
  const seq = (n: number) =>
    Buffer.from(`v1:journal:${n}`).toString('base64url');

  it('S31 AS-73: the flows are counted with bounded labels', async () => {
    const before = {
      missing: metric('assets_prepare_chunks_total', { result: 'missing' }),
      stored: metric('assets_prepare_chunks_total', { result: 'stored' }),
      created: metric('assets_commit_total', { outcome: 'created' }),
      updated: metric('assets_commit_total', { outcome: 'updated' }),
      copy: metric('assets_commit_total', { outcome: 'conflicted_copy' }),
      unchanged: metric('assets_commit_total', { outcome: 'unchanged' }),
      rejected: metric('assets_commit_total', { outcome: 'rejected' }),
      gc: metric('assets_gc_deleted_total'),
      redeemOk: metric('assets_share_redeem_total', { outcome: 'ok' }),
      redeemGone: metric('assets_share_redeem_total', {
        outcome: 'unavailable',
      }),
      dlOk: metric('assets_download_total', { kind: 'share', outcome: 'ok' }),
      dlGone: metric('assets_download_total', {
        kind: 'share',
        outcome: 'unavailable',
      }),
      granted: metric('assets_entitlement_total', { event: 'granted' }),
      ignored: metric('assets_entitlement_total', { event: 'ignored' }),
      realtime: metric('assets_realtime_publish_failures_total'),
    };
    const lag =
      MetricsRegistry.histogramValue('assets_entitlement_lag_seconds', {
        event: 'granted',
      })?.count ?? 0;

    const s = await t.seller();
    const v1 = t.randomBytes(30_000);
    const first = await t.save(s, '/m.bin', v1);
    const prepared = first.prepare.body.missing.length;
    await t.save(s, '/m.bin', Buffer.concat([v1, t.randomBytes(2_000)]), {
      baseVersion: 1,
    });
    await t.save(s, '/m.bin', t.randomBytes(30_000), {
      baseVersion: 1,
      deviceId: 'phone-2',
    });
    await t.save(s, '/m.bin', v1, { baseVersion: 0, deviceId: 'phone-3' }); // a copy again
    const same = await t.save(
      s,
      '/m.bin',
      Buffer.concat([v1, Buffer.alloc(0)]),
      { baseVersion: 99 },
    );
    expect(same.commit.status).toBe(422); // rejected: base from the future
    const reuse = await t
      .prepare(
        s,
        first.chunks.map((c) => ({ hash: c.hash, size: c.length })),
      )
      .expect(200);
    expect(reuse.body.alreadyStored).toBeGreaterThan(0);
    t.hub.mode = 'down';
    await t.commitEmpty(s, '/hub.txt').expect(201);
    t.hub.mode = 'ok';
    await t
      .commit(s, {
        path: '/m.bin',
        baseVersion: 2,
        chunks: first.chunks.map((c) => c.hash),
        sizeBytes: v1.length,
        deviceId: 'laptop-1',
      })
      .expect(201);
    await t
      .commit(s, {
        path: '/m.bin',
        baseVersion: 3,
        chunks: first.chunks.map((c) => c.hash),
        sizeBytes: v1.length,
        deviceId: 'laptop-1',
      })
      .expect(200);

    const link = await t
      .http()
      .post(`/api/shops/${s.shopId}/assets/${first.commit.body.assetId}/share`)
      .set(s.auth)
      .send({ expiresInHours: 1, maxDownloads: 1 })
      .expect(201);
    const grant = await t.rawPost(
      `/api/assets/shared/${link.body.token}/redeem`,
      { forwardedFor: address() },
    );
    expect(grant.status).toBe(200);
    expect(
      (
        await t.rawPost(`/api/assets/shared/${link.body.token}/redeem`, {
          forwardedFor: address(),
        })
      ).status,
    ).toBe(410);
    const url = new URL(JSON.parse(grant.body.toString()).url).pathname;
    expect((await t.rawGet(url, { forwardedFor: address() })).status).toBe(200);
    expect(
      (
        await t.rawGet('/api/downloads/' + 'A'.repeat(32), {
          forwardedFor: address(),
        })
      ).status,
    ).toBe(410);

    const product = await t.product(s);
    await t.link(s, product.id, first.commit.body.assetId).expect(204);
    const buyer = await t.user();
    const payload = paidPayload({
      userId: buyer.id,
      lines: [{ productId: product.id, shopId: s.shopId }],
    });
    await deliver(t.orders, paidEvent(payload));
    await deliver(
      t.orders,
      paidEvent(
        paidPayload({
          userId: buyer.id,
          lines: [{ productId: uuidv7(), shopId: s.shopId }],
        }),
      ),
    );

    const old = await t.plant(s, 25 * 3_600_000);
    await jobs.gcChunks();

    expect(
      metric('assets_prepare_chunks_total', { result: 'missing' }),
    ).toBeGreaterThanOrEqual(before.missing + prepared);
    expect(
      metric('assets_prepare_chunks_total', { result: 'stored' }),
    ).toBeGreaterThan(before.stored);
    expect(metric('assets_commit_total', { outcome: 'created' })).toBe(
      before.created + 2,
    ); // /m.bin and /hub.txt
    expect(metric('assets_commit_total', { outcome: 'updated' })).toBe(
      before.updated + 2,
    );
    expect(metric('assets_commit_total', { outcome: 'conflicted_copy' })).toBe(
      before.copy + 2,
    );
    expect(metric('assets_commit_total', { outcome: 'unchanged' })).toBe(
      before.unchanged + 1,
    );
    expect(metric('assets_commit_total', { outcome: 'rejected' })).toBe(
      before.rejected + 1,
    );
    expect(metric('assets_gc_deleted_total')).toBeGreaterThanOrEqual(
      before.gc + 1,
    );
    expect(await t.storage.head(chunkKey(s.shopId, old.hash))).toBeNull();
    expect(metric('assets_share_redeem_total', { outcome: 'ok' })).toBe(
      before.redeemOk + 1,
    );
    expect(
      metric('assets_share_redeem_total', { outcome: 'unavailable' }),
    ).toBe(before.redeemGone + 1);
    expect(
      metric('assets_download_total', { kind: 'share', outcome: 'ok' }),
    ).toBe(before.dlOk + 1);
    expect(
      metric('assets_download_total', {
        kind: 'share',
        outcome: 'unavailable',
      }),
    ).toBe(before.dlGone + 1);
    expect(metric('assets_entitlement_total', { event: 'granted' })).toBe(
      before.granted + 1,
    );
    expect(metric('assets_entitlement_total', { event: 'ignored' })).toBe(
      before.ignored + 1,
    );
    expect(metric('assets_realtime_publish_failures_total')).toBe(
      before.realtime + 1,
    );
    expect(
      MetricsRegistry.histogramValue('assets_entitlement_lag_seconds', {
        event: 'granted',
      })?.count,
    ).toBe(lag + 1);

    // the gauge exists per size tier and state, and nothing else is a label
    const tiers = MetricsRegistry.labelSets('assets_storage_bytes');
    expect(tiers.length).toBeGreaterThan(0);
    for (const labels of tiers) {
      expect(Object.keys(labels).sort()).toEqual(['state', 'tier']);
      expect(['small', 'medium', 'large']).toContain(labels.tier);
      expect(['stored', 'reserved']).toContain(labels.state);
    }
    for (const name of [
      'assets_commit_total',
      'assets_download_total',
      'assets_share_redeem_total',
    ])
      for (const labels of MetricsRegistry.labelSets(name))
        for (const value of Object.values(labels))
          expect(String(value)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  }, 120_000);

  it('S31 AS-75: every job runs once when triggered twice at once, and a repeat changes nothing', async () => {
    const s: Seller = await t.seller();

    // chunk cleanup
    const old = await t.plant(s, 25 * 3_600_000);
    const usage = async () =>
      Number(
        (
          await t.rows<{ storedBytes: string }>(
            `SELECT "storedBytes" FROM "AssetShopUsage" WHERE "shopId" = :id`,
            { id: s.shopId },
          )
        )[0].storedBytes,
      );
    expect(await usage()).toBe(4_000);
    await Promise.all([jobs.gcChunks(), jobs.gcChunks()]);
    expect(await usage()).toBe(0);
    expect(
      await t.rows(
        `SELECT 1 FROM "AssetChunk" WHERE "shopId" = :id AND "hash" = :hash`,
        { id: s.shopId, hash: old.hash },
      ),
    ).toEqual([]);
    await jobs.gcChunks();
    expect(await usage()).toBe(0);

    // purge of deleted assets
    const saved = await t.save(s, '/p.bin', t.randomBytes(20_000));
    const second = await t.save(s, '/p.bin', t.randomBytes(8_000), {
      baseVersion: 1,
    });
    await t
      .http()
      .delete(`/api/shops/${s.shopId}/assets/${second.commit.body.assetId}`)
      .set(s.auth)
      .expect(204);
    await t.advance(31 * DAY);
    await Promise.all([jobs.purgeDeletedAssets(), jobs.purgeDeletedAssets()]);
    const refs = await t.rows<{ refCount: number }>(
      `SELECT "refCount" FROM "AssetChunk" WHERE "shopId" = :id`,
      { id: s.shopId },
    );
    expect(refs.every((r) => r.refCount === 0)).toBe(true);
    await jobs.purgeDeletedAssets();
    expect(
      (
        await t.rows<{ status: string }>(
          `SELECT "status" FROM "Asset" WHERE "id" = :id`,
          { id: saved.commit.body.assetId },
        )
      )[0].status,
    ).toBe('PURGED');

    // expired download grants
    const live = await t.seller();
    const file = await t.save(live, '/g.bin', t.randomBytes(5_000));
    const link = await t
      .http()
      .post(
        `/api/shops/${live.shopId}/assets/${file.commit.body.assetId}/share`,
      )
      .set(live.auth)
      .send({ expiresInHours: 100 })
      .expect(201);
    await t.rawPost(`/api/assets/shared/${link.body.token}/redeem`, {
      forwardedFor: address(),
    });
    const grants = () =>
      t.rows(`SELECT 1 FROM "AssetDownloadGrant" WHERE "shopId" = :id`, {
        id: live.shopId,
      });
    await Promise.all([jobs.purgeDownloadGrants(), jobs.purgeDownloadGrants()]);
    expect(await grants()).toHaveLength(1); // still valid
    await t.advance(121_000);
    await Promise.all([jobs.purgeDownloadGrants(), jobs.purgeDownloadGrants()]);
    expect(await grants()).toEqual([]);
    await jobs.purgeDownloadGrants();
    expect(await grants()).toEqual([]);

    // journal retention
    await Promise.all([jobs.purgeChanges(), jobs.purgeChanges()]);
    await jobs.purgeChanges();
  }, 120_000);

  it('S31 AS-79: no foreign key leaves the domain', async () => {
    const own = [
      'Asset',
      'AssetVersion',
      'AssetVersionChunk',
      'AssetChunk',
      'AssetChange',
      'AssetSyncState',
      'AssetShopUsage',
      'AssetShareLink',
      'AssetDownloadGrant',
      'DigitalProduct',
      'AssetEntitlement',
      'AssetOrderRevocation',
    ];
    const keys = await t.rows<{ tbl: string; ref: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref
         FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = ANY (SELECT to_regclass('"' || n || '"') FROM unnest(CAST(:own AS text[])) AS n)`,
      { own: `{${own.join(',')}}` },
    );
    expect(keys.filter((k) => !own.includes(k.ref.replace(/"/g, '')))).toEqual(
      [],
    );
  });

  it('S31 AS-76: journal entries older than 90 days go, the floor is recorded, and an old cursor is expired', async () => {
    const s = await t.seller();
    await t.commitEmpty(s, '/old-1.txt').expect(201);
    await t.commitEmpty(s, '/old-2.txt').expect(201);
    await t.advance(2 * DAY);
    await t.commitEmpty(s, '/new-3.txt').expect(201);
    await t.commitEmpty(s, '/new-4.txt').expect(201);
    await t.advance(89 * DAY); // the first two are 91 days old, the last two 89
    expect(await journalSeqs(s.shopId)).toEqual([1, 2, 3, 4]);

    await jobs.purgeChanges();
    expect(await journalSeqs(s.shopId)).toEqual([3, 4]);
    const [state] = await t.rows<{ minSeq: string; lastSeq: string }>(
      `SELECT "minSeq", "lastSeq" FROM "AssetSyncState" WHERE "shopId" = :id`,
      { id: s.shopId },
    );
    expect(Number(state.minSeq)).toBe(2);
    expect(Number(state.lastSeq)).toBe(4);

    const read = (cursor: string) =>
      t
        .http()
        .get(`/api/shops/${s.shopId}/assets/changes`)
        .query({ cursor })
        .set(s.auth);
    const expired = await read(seq(0)).expect(410);
    expect(expired.body.code).toBe('cursor_expired');
    await read(seq(1)).expect(410);
    const current = await read(seq(2)).expect(200);
    expect(current.body.items.map((i: { seq: number }) => i.seq)).toEqual([
      3, 4,
    ]);
    await read(seq(4)).expect(200);
    const listing = await t
      .http()
      .get(`/api/shops/${s.shopId}/assets`)
      .set(s.auth)
      .expect(200);
    await read(listing.body.syncCursor).expect(200);
  });
});

describe('Asset library: logs', () => {
  let t: AssetTestApp;
  beforeAll(async () => {
    t = await createAssetApp({ captureLogs: true });
  });
  afterAll(async () => {
    await t.close();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

  it('S31 AS-74: tokens, presigned queries and bodies never reach a log line', async () => {
    const s = await t.seller();
    const marker = `/body-marker-${uuidv7()}.txt`;
    const saved = await t.save(s, marker, t.randomBytes(8_000));
    const link = await t
      .http()
      .post(`/api/shops/${s.shopId}/assets/${saved.commit.body.assetId}/share`)
      .set(s.auth)
      .send({ expiresInHours: 1 })
      .expect(201);
    const token: string = link.body.token;
    const forwarded = '203.0.113.201';
    await t.rawGet(`/api/assets/shared/${token}`, { forwardedFor: forwarded });
    const grant = JSON.parse(
      (
        await t.rawPost(`/api/assets/shared/${token}/redeem`, {
          forwardedFor: forwarded,
        })
      ).body.toString(),
    );
    const grantToken = new URL(grant.url).pathname.split('/').pop()!;
    await t.rawGet(new URL(grant.url).pathname, { forwardedFor: forwarded });
    await t.rawGet(`/api/assets/shared/${'Z'.repeat(32)}`, {
      forwardedFor: forwarded,
    }); // a failing call is logged too
    await t.rawGet(`/api/downloads/${'Y'.repeat(32)}`, {
      forwardedFor: forwarded,
    });

    const product = await t.product(s);
    await t.link(s, product.id, saved.commit.body.assetId).expect(204);
    const buyer = await t.user();
    await t.buy(s, buyer, product.id);
    const buyerGrant = (
      await t
        .http()
        .post(`/api/me/purchases/${product.id}/download`)
        .set(buyer.auth)
        .expect(200)
    ).body;
    const buyerToken = new URL(buyerGrant.url).pathname.split('/').pop()!;
    await t.rawGet(new URL(buyerGrant.url).pathname, {
      forwardedFor: forwarded,
    });
    const manifest = await t
      .http()
      .get(
        `/api/shops/${s.shopId}/assets/${saved.commit.body.assetId}/manifest`,
      )
      .set(s.auth)
      .expect(200);
    const presigned = manifest.body.chunks[0].url as string;
    await settle();

    const logs = t.logLines();
    for (const secret of [
      token,
      grantToken,
      buyerToken,
      'Z'.repeat(32),
      'Y'.repeat(32),
      marker,
      'X-Amz-Signature',
      'X-Amz-Credential',
      new URL(presigned).search.slice(1, 40),
    ])
      expect(logs).not.toContain(secret);

    const access = logs
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'request completed');
    const routes = access.map((l) => String(l.route));
    expect(routes.some((r) => r.endsWith('/assets/shared/:token'))).toBe(true);
    expect(routes.some((r) => r.endsWith('/assets/shared/:token/redeem'))).toBe(
      true,
    );
    expect(routes.some((r) => r.endsWith('/downloads/:token'))).toBe(true);
    for (const line of access) expect(typeof line.requestId).toBe('string');
  });
});
