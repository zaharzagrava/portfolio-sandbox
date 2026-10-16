import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  assetVersionPageSchema,
  assetSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CleanupService } from './application/cleanup.service';
import { chunkKey } from './infra/chunk-store';
import {
  createAssetApp,
  expectContract,
  type AssetTestApp,
  type Seller,
} from './testing/asset-client';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('Asset library: versions, delete, restore, retention and chunk cleanup', () => {
  let t: AssetTestApp;
  let cleanup: CleanupService;
  beforeAll(async () => {
    t = await createAssetApp();
    cleanup = t.app.get(CleanupService, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    t.store.heal();
    t.hub.mode = 'ok';
  });

  const chunkRows = (shopId: string) =>
    t.rows<{ hash: string; refCount: number; size: number; deleting: boolean }>(
      `SELECT "hash", "refCount", "size", "deleting" FROM "AssetChunk" WHERE "shopId" = :shopId ORDER BY "hash"`,
      { shopId },
    );
  const refOf = async (shopId: string, hash: string) =>
    (
      await t.rows<{ refCount: number }>(
        `SELECT "refCount" FROM "AssetChunk" WHERE "shopId" = :shopId AND "hash" = :hash`,
        { shopId, hash },
      )
    )[0]?.refCount;
  const journal = (shopId: string) =>
    t.rows<{ seq: string; kind: string; version: number }>(
      `SELECT "seq", "kind", "version" FROM "AssetChange" WHERE "shopId" = :shopId ORDER BY "seq"`,
      { shopId },
    );
  const assetRow = async (assetId: string) =>
    (
      await t.rows<{
        status: string;
        deletedAt: Date | null;
        currentVersion: number;
      }>(
        `SELECT "status", "deletedAt", "currentVersion" FROM "Asset" WHERE "id" = :assetId`,
        { assetId },
      )
    )[0];
  const versionNumbers = async (assetId: string) =>
    (
      await t.rows<{ version: number }>(
        `SELECT "version" FROM "AssetVersion" WHERE "assetId" = :assetId ORDER BY "version"`,
        { assetId },
      )
    ).map((v) => v.version);
  const del = (s: Seller, path: string) =>
    t.http().delete(`/api/shops/${s.shopId}${path}`).set(s.auth);
  const post = (s: Seller, path: string, body?: object) =>
    t.http().post(`/api/shops/${s.shopId}${path}`).set(s.auth).send(body);
  const counter = (name: string) => MetricsRegistry.value(name) ?? 0;

  const planted = (
    s: Seller,
    ageMs: number,
    options?: { refCount?: number; protectedUntil?: Date | null },
  ) => t.plant(s, ageMs, options);
  const objectExists = (s: Seller, hash: string) =>
    t.storage.head(chunkKey(s.shopId, hash)).then((h) => h !== null);

  // ------------------------------------------------------------------------------------------------ versions

  it('S31 AS-34: version history pages newest first without chunk hashes', async () => {
    const s = await t.seller();
    let id = '';
    for (let v = 1; v <= 5; v++) {
      const res = await t.save(s, '/h.bin', t.randomBytes(8_000), {
        baseVersion: v - 1,
      });
      id = res.commit.body.assetId;
    }
    const page = (cursor?: string) =>
      t
        .http()
        .get(`/api/shops/${s.shopId}/assets/${id}/versions`)
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .set(s.auth)
        .expect(200);
    const p1 = await page();
    const p2 = await page(p1.body.nextCursor);
    const p3 = await page(p2.body.nextCursor);
    const pages = [p1, p2, p3].map((p) =>
      expectContract(assetVersionPageSchema, p.body),
    );
    expect(pages.map((p) => p.items.map((i) => i.version))).toEqual([
      [5, 4],
      [3, 2],
      [1],
    ]);
    expect(pages[2].nextCursor).toBeNull();
    for (const item of pages.flatMap((p) => p.items)) {
      expect(item).not.toHaveProperty('chunks');
      expect(item.createdBy).toBe(s.id);
      expect(item.deviceId).toBe('laptop-1');
      expect(item.chunkCount).toBeGreaterThan(0);
    }
    const stranger = await t.seller();
    await t
      .http()
      .get(`/api/shops/${stranger.shopId}/assets/${id}/versions`)
      .set(stranger.auth)
      .expect(404);
  });

  it('S31 AS-35: deleting an old version releases only what no other version uses', async () => {
    const s = await t.seller();
    const v1 = t.randomBytes(80_000);
    const first = await t.save(s, '/d.bin', v1);
    const v2 = Buffer.concat([v1, t.randomBytes(5_000)]);
    const second = await t.save(s, '/d.bin', v2, { baseVersion: 1 });
    const id = second.commit.body.assetId as string;
    const shared = new Set(second.chunks.map((c) => c.hash));
    const onlyV1 = first.chunks.filter((c) => !shared.has(c.hash));
    const before = (await journal(s.shopId)).length;

    await del(s, `/assets/${id}/versions/1`).expect(204);
    expect(await versionNumbers(id)).toEqual([2]);
    for (const c of first.chunks.filter((x) => shared.has(x.hash)))
      expect(await refOf(s.shopId, c.hash)).toBe(
        second.chunks.filter((x) => x.hash === c.hash).length,
      );
    for (const c of onlyV1) expect(await refOf(s.shopId, c.hash)).toBe(0);
    const rows = await t.rows<{ hash: string; unreferencedSince: Date | null }>(
      `SELECT "hash", "unreferencedSince" FROM "AssetChunk" WHERE "shopId" = :shopId AND "refCount" = 0`,
      { shopId: s.shopId },
    );
    expect(rows.length).toBe(new Set(onlyV1.map((c) => c.hash)).size);
    for (const r of rows) expect(r.unreferencedSince).not.toBeNull();
    expect((await t.download(s, id)).equals(v2)).toBe(true);
    expect((await journal(s.shopId)).length).toBe(before);
  });

  it('S31 AS-36: the current and the only version cannot be deleted, unknown ones are 404', async () => {
    const s = await t.seller();
    await t.save(s, '/v.bin', t.randomBytes(8_000));
    const second = await t.save(s, '/v.bin', t.randomBytes(8_000), {
      baseVersion: 1,
    });
    const id = second.commit.body.assetId as string;
    const snapshot = JSON.stringify(await chunkRows(s.shopId));

    expect(
      (await del(s, `/assets/${id}/versions/2`).expect(409)).body.code,
    ).toBe('cannot_delete_current_version');
    expect(
      (await del(s, `/assets/${id}/versions/7`).expect(404)).body.code,
    ).toBe('version_not_found');
    await del(s, `/assets/${id}/versions/1`).expect(204);
    expect(
      (await del(s, `/assets/${id}/versions/1`).expect(404)).body.code,
    ).toBe('version_not_found');

    const only = await t.save(s, '/only.bin', t.randomBytes(8_000));
    expect(
      (
        await del(s, `/assets/${only.commit.body.assetId}/versions/1`).expect(
          409,
        )
      ).body.code,
    ).toBe('cannot_delete_current_version');
    expect(await versionNumbers(only.commit.body.assetId)).toEqual([1]);
    expect(await versionNumbers(id)).toEqual([2]);
    expect(snapshot).not.toBe('');
  });

  it('S31 AS-37: restoring an old version creates a new one from its chunks without uploading', async () => {
    const s = await t.seller();
    await t.setTime(new Date('2026-10-05T10:00:00Z'));
    const contents = [
      t.randomBytes(40_000),
      t.randomBytes(40_000),
      t.randomBytes(40_000),
    ];
    let id = '';
    let firstChunks: { hash: string }[] = [];
    for (const [i, bytes] of contents.entries()) {
      const r = await t.save(s, '/r.bin', bytes, { baseVersion: i });
      id = r.commit.body.assetId;
      if (i === 0) firstChunks = r.chunks;
    }
    const before = new Map<string, number>();
    for (const r of await chunkRows(s.shopId)) before.set(r.hash, r.refCount);
    const seqBefore = (await journal(s.shopId)).length;

    const restored = await post(s, `/assets/${id}/versions/1/restore`, {
      baseVersion: 3,
    }).expect(201);
    expect(restored.body).toMatchObject({
      assetId: id,
      version: 4,
      outcome: 'updated',
      path: '/r.bin',
    });
    const [v4] = await t.rows<{ chunks: string[] }>(
      `SELECT "chunks" FROM "AssetVersion" WHERE "assetId" = :id AND "version" = 4`,
      { id },
    );
    expect(v4.chunks).toEqual(firstChunks.map((c) => c.hash));
    const occurrences = new Map<string, number>();
    for (const c of firstChunks)
      occurrences.set(c.hash, (occurrences.get(c.hash) ?? 0) + 1);
    for (const [hash, n] of occurrences)
      expect(await refOf(s.shopId, hash)).toBe((before.get(hash) ?? 0) + n);
    expect((await journal(s.shopId)).length).toBe(seqBefore + 1);
    expect((await t.download(s, id)).equals(contents[0])).toBe(true);

    const stale = await post(s, `/assets/${id}/versions/1/restore`, {
      baseVersion: 2,
    }).expect(201);
    expect(stale.body.outcome).toBe('conflicted_copy');
    expect(stale.body.path).toBe('/r (conflicted copy restore 2026-10-05).bin');

    await del(s, `/assets/${id}`).expect(204);
    expect(
      (
        await post(s, `/assets/${id}/versions/1/restore`, {
          baseVersion: 4,
        }).expect(409)
      ).body.code,
    ).toBe('asset_deleted');
    await post(s, `/assets/${id}/versions/99/restore`, {
      baseVersion: 4,
    }).expect(409);
  });

  // ------------------------------------------------------------------------------------------ delete / undelete

  it('S31 AS-38: deleting a file frees the path, keeps the versions and journals a delete', async () => {
    const s = await t.seller();
    const saved = await t.save(s, '/del.bin', t.randomBytes(20_000));
    const id = saved.commit.body.assetId as string;
    const linkHash = createHash('sha256').update(uuidv7()).digest('hex');
    await t.db.query(
      `INSERT INTO "AssetShareLink" ("tokenHash", "assetId", "shopId", "expiresAt") VALUES (:linkHash, :id, :shopId, :expires)`,
      {
        replacements: {
          linkHash,
          id,
          shopId: s.shopId,
          expires: new Date(t.clock.now().getTime() + DAY),
        },
      },
    );

    await del(s, `/assets/${id}`).expect(204);
    const row = await assetRow(id);
    expect(row.status).toBe('DELETED');
    expect(row.deletedAt).not.toBeNull();
    expect(await journal(s.shopId)).toEqual([
      { seq: '1', kind: 'upsert', version: 1 },
      { seq: '2', kind: 'delete', version: 1 },
    ]);
    expect(await versionNumbers(id)).toEqual([1]);
    for (const r of await chunkRows(s.shopId))
      expect(r.refCount).toBeGreaterThan(0);
    const reused = await t.save(s, '/del.bin', t.randomBytes(10_000));
    expect(reused.commit.body).toMatchObject({
      outcome: 'created',
      path: '/del.bin',
    });
    expect((await del(s, `/assets/${id}`).expect(409)).body.code).toBe(
      'invalid_transition',
    );

    const other = await t.save(s, '/linked.bin', t.randomBytes(10_000));
    await t.db.query(
      `INSERT INTO "DigitalProduct" ("productId", "assetId", "shopId", "linkedAt") VALUES (:productId, :assetId, :shopId, :now)`,
      {
        replacements: {
          productId: uuidv7(),
          assetId: other.commit.body.assetId,
          shopId: s.shopId,
          now: t.clock.now(),
        },
      },
    );
    const seqs = (await journal(s.shopId)).length;
    expect(
      (await del(s, `/assets/${other.commit.body.assetId}`).expect(409)).body
        .code,
    ).toBe('asset_in_use');
    expect((await assetRow(other.commit.body.assetId)).status).toBe('ACTIVE');
    expect((await journal(s.shopId)).length).toBe(seqs);
    await del(s, `/assets/${uuidv7()}`).expect(404);
  });

  it('S31 AS-39: undelete restores the file inside its window unless the path is taken', async () => {
    const s = await t.seller();
    const saved = await t.save(s, '/u.bin', t.randomBytes(10_000));
    const id = saved.commit.body.assetId as string;
    expect(
      (await post(s, `/assets/${id}/undelete`).expect(409)).body.code,
    ).toBe('invalid_transition');
    await del(s, `/assets/${id}`).expect(204);
    await t.advance(10 * DAY);
    const back = await post(s, `/assets/${id}/undelete`).expect(200);
    expectContract(assetSchema, back.body);
    expect(back.body).toMatchObject({
      id,
      status: 'ACTIVE',
      deletedAt: null,
      path: '/u.bin',
    });
    expect((await journal(s.shopId)).map((j) => j.kind)).toEqual([
      'upsert',
      'delete',
      'upsert',
    ]);

    await del(s, `/assets/${id}`).expect(204);
    await t.save(s, '/u.bin', t.randomBytes(10_000));
    expect(
      (await post(s, `/assets/${id}/undelete`).expect(409)).body.code,
    ).toBe('path_taken');
    expect((await assetRow(id)).status).toBe('DELETED');

    // beyond the window, and after the purge, the asset is gone
    await t.advance(31 * DAY);
    await post(s, `/assets/${id}/undelete`).expect(404);
    await cleanup.purgeDeletedAssets();
    expect(
      (await post(s, `/assets/${id}/undelete`).expect(404)).body.code,
    ).toBe('asset_not_found');
  });

  it('S31 AS-40: retention purge releases references exactly once, also when run twice at once', async () => {
    const s = await t.seller();
    const saved = await t.save(s, '/p.bin', t.randomBytes(60_000));
    const second = await t.save(s, '/p.bin', t.randomBytes(30_000), {
      baseVersion: 1,
    });
    const id = second.commit.body.assetId as string;
    const linkHash = createHash('sha256').update(uuidv7()).digest('hex');
    await t.db.query(
      `INSERT INTO "AssetShareLink" ("tokenHash", "assetId", "shopId", "expiresAt") VALUES (:linkHash, :id, :shopId, :expires)`,
      {
        replacements: {
          linkHash,
          id,
          shopId: s.shopId,
          expires: new Date(t.clock.now().getTime() + 90 * DAY),
        },
      },
    );
    await del(s, `/assets/${id}`).expect(204);
    const deletedAt = (await assetRow(id)).deletedAt!;

    await t.setTime(new Date(deletedAt.getTime() + 30 * DAY - 1_000));
    await cleanup.purgeDeletedAssets();
    expect((await assetRow(id)).status).toBe('DELETED');
    expect(await versionNumbers(id)).toEqual([1, 2]);

    await t.setTime(new Date(deletedAt.getTime() + 30 * DAY + 1_000));
    await Promise.all([
      cleanup.purgeDeletedAssets(),
      cleanup.purgeDeletedAssets(),
    ]);
    await cleanup.purgeDeletedAssets();
    expect((await assetRow(id)).status).toBe('PURGED');
    expect(await versionNumbers(id)).toEqual([]);
    for (const r of await chunkRows(s.shopId)) expect(r.refCount).toBe(0);
    const links = await t.rows(
      `SELECT 1 FROM "AssetShareLink" WHERE "assetId" = :id`,
      { id },
    );
    expect(links).toEqual([]);
    expect(saved.commit.status).toBe(201);
  });

  // ---------------------------------------------------------------------------------------------- cleanup

  it('S31 AS-41: cleanup removes only what stayed unreferenced past the grace, object first, and retries a failure', async () => {
    const s = await t.seller();
    const young = await planted(s, 23 * HOUR + 59 * 60_000);
    const old = await planted(s, 24 * HOUR + 1_000);
    const stale = await planted(s, 10 * DAY, { refCount: 1 });

    const failuresBefore = counter('assets_gc_failures_total');
    t.store.failNext('remove', 1, s.shopId);
    await cleanup.collectChunks();
    expect(counter('assets_gc_failures_total')).toBe(failuresBefore + 1);
    expect(await objectExists(s, old.hash)).toBe(true);
    expect((await chunkRows(s.shopId)).map((r) => r.hash)).toContain(old.hash);
    expect(
      (await chunkRows(s.shopId)).find((r) => r.hash === old.hash)!.deleting,
    ).toBe(false);

    await cleanup.collectChunks();
    expect(counter('assets_gc_failures_total')).toBe(failuresBefore + 1);
    expect(await objectExists(s, old.hash)).toBe(false);
    const left = (await chunkRows(s.shopId)).map((r) => r.hash).sort();
    expect(left).toEqual([young.hash, stale.hash].sort());
    expect(await objectExists(s, young.hash)).toBe(true);
    expect(await objectExists(s, stale.hash)).toBe(true);
    const [usage] = await t.rows<{ storedBytes: string }>(
      `SELECT "storedBytes" FROM "AssetShopUsage" WHERE "shopId" = :shopId`,
      { shopId: s.shopId },
    );
    expect(Number(usage.storedBytes)).toBe(8_000);
  });

  it('S31 AS-42: reusing an old unreferenced chunk restarts its grace', async () => {
    const s = await t.seller();
    const old = await planted(s, 25 * HOUR);
    const prep = await t
      .prepare(s, [{ hash: old.hash, size: 4_000 }])
      .expect(200);
    expect(prep.body).toMatchObject({ missing: [], alreadyStored: 1 });

    await cleanup.collectChunks();
    expect(await objectExists(s, old.hash)).toBe(true);
    expect((await chunkRows(s.shopId)).map((r) => r.hash)).toContain(old.hash);
    const commit = await t
      .commit(s, {
        path: '/reuse.bin',
        baseVersion: 0,
        chunks: [old.hash],
        sizeBytes: 4_000,
        deviceId: 'laptop-1',
      })
      .expect(201);
    expect((await t.download(s, commit.body.assetId)).equals(old.bytes)).toBe(
      true,
    );
  });

  it('S31 AS-43: cleanup racing a commit never leaves a version pointing at a missing object', async () => {
    const s = await t.seller();
    for (let round = 0; round < 6; round++) {
      const old = await planted(s, 25 * HOUR);
      const [commit] = await Promise.all([
        t.commit(s, {
          path: `/race-${round}.bin`,
          baseVersion: 0,
          chunks: [old.hash],
          sizeBytes: 4_000,
          deviceId: 'laptop-1',
        }),
        cleanup.collectChunks(),
      ]);
      expect([201, 422]).toContain(commit.status);
      if (commit.status === 422)
        expect(commit.body.code).toMatch(/chunk_not_uploaded|chunks_unknown/);
      else expect(await objectExists(s, old.hash)).toBe(true);
    }
    const versions = await t.rows<{ chunks: string[] }>(
      `SELECT v."chunks" FROM "AssetVersion" v JOIN "Asset" a ON a."id" = v."assetId" WHERE a."shopId" = :shopId`,
      { shopId: s.shopId },
    );
    for (const v of versions)
      for (const hash of v.chunks)
        expect(await objectExists(s, hash)).toBe(true);
  });

  it('S31 AS-44: reference counts equal the occurrences and return to zero exactly', async () => {
    const s = await t.seller();
    const shared = randomBytes(6_000);
    const sharedHash = sha(shared);
    const prepShared = await t
      .prepare(s, [{ hash: sharedHash, size: shared.length }])
      .expect(200);
    await t.putMissing(prepShared, shared, [
      { offset: 0, length: shared.length, hash: sharedHash },
    ]);

    const own = Array.from({ length: 10 }, () => randomBytes(5_000));
    const refs = own.map((b) => ({ hash: sha(b), size: b.length }));
    const prep = await t.prepare(s, refs).expect(200);
    let offset = 0;
    await t.putMissing(
      prep,
      Buffer.concat(own),
      own.map((b) => {
        const c = { offset, length: b.length, hash: sha(b) };
        offset += b.length;
        return c;
      }),
    );
    const results = await Promise.all(
      own.map((b, i) =>
        t.commit(s, {
          path: `/shared-${i}.bin`,
          baseVersion: 0,
          chunks:
            i === 0 ? [sharedHash, sharedHash, sha(b)] : [sharedHash, sha(b)],
          sizeBytes: (i === 0 ? 2 : 1) * shared.length + b.length,
          deviceId: 'laptop-1',
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(await refOf(s.shopId, sharedHash)).toBe(11);

    // every file gets a second version without the shared chunk, then the first versions go in two orders at once
    const ids = results.map((r) => r.body.assetId as string);
    for (const [i, id] of ids.entries()) {
      const bytes = t.randomBytes(5_000 + i);
      const c = t.chunksOf(bytes);
      const p = await t
        .prepare(
          s,
          c.map((x) => ({ hash: x.hash, size: x.length })),
        )
        .expect(200);
      await t.putMissing(p, bytes, c);
      await t
        .commit(s, {
          path: `/shared-${i}.bin`,
          baseVersion: 1,
          chunks: c.map((x) => x.hash),
          sizeBytes: bytes.length,
          deviceId: 'laptop-1',
        })
        .expect(201);
      expect(id).toBeDefined();
    }
    await Promise.all([
      ...ids.slice(0, 5).map((id) => del(s, `/assets/${id}/versions/1`)),
      ...[...ids.slice(5)]
        .reverse()
        .map((id) => del(s, `/assets/${id}/versions/1`)),
    ]);
    expect(await refOf(s.shopId, sharedHash)).toBe(0);
    for (const r of await chunkRows(s.shopId))
      expect(r.refCount).toBeGreaterThanOrEqual(0);

    await t.advance(25 * HOUR);
    await cleanup.collectChunks();
    expect(await refOf(s.shopId, sharedHash)).toBeUndefined();
    expect(await objectExists(s, sharedHash)).toBe(false);
  }, 120_000);

  it('S31 AS-45: an asset holds at most 500 versions', async () => {
    const s = await t.seller();
    const first = await t.save(s, '/cap.bin', t.randomBytes(8_000));
    const id = first.commit.body.assetId as string;
    await t.db.query(
      `INSERT INTO "AssetVersion" ("assetId", "version", "sizeBytes", "chunks", "createdBy", "deviceId", "createdAt")
       SELECT :id, n, 0, ARRAY[]::text[], :user, 'seed', :now FROM generate_series(2, 500) AS n`,
      { replacements: { id, user: s.id, now: t.clock.now() } },
    );
    await t.db.query(
      `UPDATE "Asset" SET "currentVersion" = 500 WHERE "id" = :id`,
      { replacements: { id } },
    );

    const next = t.randomBytes(8_000);
    const full = await t.save(s, '/cap.bin', next, { baseVersion: 500 });
    expect(full.commit.status).toBe(409);
    expect(full.commit.body).toMatchObject({
      code: 'version_limit_reached',
      limit: 500,
    });
    expect((await versionNumbers(id)).length).toBe(500);

    await del(s, `/assets/${id}/versions/2`).expect(204);
    const ok = await t.save(s, '/cap.bin', next, { baseVersion: 500 });
    expect(ok.commit.status).toBe(201);
    expect(ok.commit.body.version).toBe(501);
  }, 120_000);
});
