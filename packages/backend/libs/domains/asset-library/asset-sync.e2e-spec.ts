import { createHash, randomBytes } from 'node:crypto';
import {
  assetChangePageSchema,
  assetManifestSchema,
  assetPageSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  createAssetApp,
  expectContract,
  type AssetTestApp,
  type Seller,
} from './testing/asset-client';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('Asset library: conflicts, change journal, listing, manifest and notifications', () => {
  let t: AssetTestApp;
  beforeAll(async () => {
    t = await createAssetApp();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    t.store.heal();
    t.hub.mode = 'ok';
  });

  const assetsAt = (shopId: string) =>
    t.rows<{
      id: string;
      path: string;
      status: string;
      currentVersion: number;
    }>(
      `SELECT "id", "path", "status", "currentVersion" FROM "Asset" WHERE "shopId" = :shopId ORDER BY "path"`,
      { shopId },
    );
  const versionNumbers = async (assetId: string) =>
    (
      await t.rows<{ version: number }>(
        `SELECT "version" FROM "AssetVersion" WHERE "assetId" = :assetId ORDER BY "version"`,
        { assetId },
      )
    ).map((v) => v.version);
  const seqs = async (shopId: string) =>
    (
      await t.rows<{ seq: string }>(
        `SELECT "seq" FROM "AssetChange" WHERE "shopId" = :shopId ORDER BY "seq"`,
        { shopId },
      )
    ).map((r) => Number(r.seq));
  const failures = () =>
    MetricsRegistry.value('assets_realtime_publish_failures_total') ?? 0;
  const syncCursor = async (s: Seller) =>
    (
      await t
        .http()
        .get(`/api/shops/${s.shopId}/assets`)
        .set(s.auth)
        .expect(200)
    ).body.syncCursor as string;

  // ---------------------------------------------------------------------------------------------- conflicts

  it('S31 AS-21: a stale save becomes a conflicted copy and both contents survive', async () => {
    await t.setTime(new Date('2026-10-05T10:00:00Z'));
    const s = await t.seller();
    const base = t.randomBytes(30_000);
    const first = await t.save(s, '/manual.txt', base, {
      deviceId: 'laptop-1',
    });
    expect(first.commit.status).toBe(201);
    const laptop = t.randomBytes(30_000);
    const second = await t.save(s, '/manual.txt', laptop, {
      baseVersion: 1,
      deviceId: 'laptop-1',
    });
    expect(second.commit.body).toMatchObject({
      version: 2,
      outcome: 'updated',
    });

    const phone = t.randomBytes(30_000);
    const copy = await t.save(s, '/manual.txt', phone, {
      baseVersion: 1,
      deviceId: 'phone-2',
    });
    expect(copy.commit.status).toBe(201);
    expect(copy.commit.body).toMatchObject({
      outcome: 'conflicted_copy',
      conflicted: true,
      path: '/manual (conflicted copy phone-2 2026-10-05).txt',
      version: 1,
    });
    expect(copy.commit.body.assetId).not.toBe(first.commit.body.assetId);

    const original = (await assetsAt(s.shopId)).find(
      (a) => a.path === '/manual.txt',
    )!;
    expect(original.currentVersion).toBe(2);
    expect((await t.download(s, original.id)).equals(laptop)).toBe(true);
    expect((await t.download(s, copy.commit.body.assetId)).equals(phone)).toBe(
      true,
    );
    expect(await seqs(s.shopId)).toEqual([1, 2, 3]);
    const changes = await t
      .http()
      .get(`/api/shops/${s.shopId}/assets/changes`)
      .query({ cursor: Buffer.from('v1:journal:2').toString('base64url') })
      .set(s.auth)
      .expect(200);
    expect(changes.body.items).toEqual([
      expect.objectContaining({
        seq: 3,
        kind: 'upsert',
        assetId: copy.commit.body.assetId,
      }),
    ]);
  });

  it('S31 AS-22: copies never overwrite copies', async () => {
    await t.setTime(new Date('2026-10-05T10:00:00Z'));
    const s = await t.seller();
    await t.save(s, '/manual.txt', t.randomBytes(20_000));
    const contents = [
      t.randomBytes(20_000),
      t.randomBytes(20_000),
      t.randomBytes(20_000),
    ];
    const paths: string[] = [];
    const ids: string[] = [];
    for (const bytes of contents) {
      const copy = await t.save(s, '/manual.txt', bytes, {
        baseVersion: 0,
        deviceId: 'phone-2',
      });
      expect(copy.commit.body.outcome).toBe('conflicted_copy');
      paths.push(copy.commit.body.path);
      ids.push(copy.commit.body.assetId);
    }
    expect(paths).toEqual([
      '/manual (conflicted copy phone-2 2026-10-05).txt',
      '/manual (conflicted copy phone-2 2026-10-05) (2).txt',
      '/manual (conflicted copy phone-2 2026-10-05) (3).txt',
    ]);
    for (const [i, id] of ids.entries()) {
      expect(await versionNumbers(id)).toEqual([1]);
      expect((await t.download(s, id)).equals(contents[i])).toBe(true);
    }
  });

  it('S31 AS-24: two commits on one base at once give one update and one copy', async () => {
    await t.setTime(new Date('2026-10-05T10:00:00Z'));
    const s = await t.seller();
    const original = await t.save(s, '/m.txt', t.randomBytes(20_000));
    const [a, b] = await Promise.all([
      t.save(s, '/m.txt', t.randomBytes(20_000), {
        baseVersion: 1,
        deviceId: 'laptop-1',
      }),
      t.save(s, '/m.txt', t.randomBytes(20_000), {
        baseVersion: 1,
        deviceId: 'phone-2',
      }),
    ]);
    expect([a.commit.status, b.commit.status]).toEqual([201, 201]);
    expect([a.commit.body.outcome, b.commit.body.outcome].sort()).toEqual([
      'conflicted_copy',
      'updated',
    ]);
    expect(await versionNumbers(original.commit.body.assetId)).toEqual([1, 2]);
    const copy = [a, b].find(
      (x) => x.commit.body.outcome === 'conflicted_copy',
    )!;
    expect(await versionNumbers(copy.commit.body.assetId)).toEqual([1]);
    expect(await seqs(s.shopId)).toEqual([1, 2, 3]);
  });

  it('S31 AS-25: a device that did not know the file gets a copy', async () => {
    const s = await t.seller();
    await t.save(s, '/m.txt', t.randomBytes(10_000));
    await t.save(s, '/m.txt', t.randomBytes(10_000), { baseVersion: 1 });
    const res = await t.save(s, '/m.txt', t.randomBytes(10_000), {
      baseVersion: 0,
      deviceId: 'phone-2',
    });
    expect(res.commit.body.outcome).toBe('conflicted_copy');
    expect(res.commit.body.path).toMatch(
      /^\/m \(conflicted copy phone-2 \d{4}-\d{2}-\d{2}\)\.txt$/,
    );
  });

  it('S31 AS-26: an edit of a file deleted elsewhere recreates it, the deleted one stays deleted', async () => {
    const s = await t.seller();
    const first = await t.save(s, '/m.txt', t.randomBytes(10_000));
    await t.save(s, '/m.txt', t.randomBytes(10_000), { baseVersion: 1 });
    await t
      .http()
      .delete(`/api/shops/${s.shopId}/assets/${first.commit.body.assetId}`)
      .set(s.auth)
      .expect(204);
    const edited = await t.save(s, '/m.txt', t.randomBytes(10_000), {
      baseVersion: 2,
      deviceId: 'phone-2',
    });
    expect(edited.commit.status).toBe(201);
    expect(edited.commit.body).toMatchObject({
      outcome: 'created',
      conflicted: false,
      version: 1,
      path: '/m.txt',
    });
    expect(edited.commit.body.assetId).not.toBe(first.commit.body.assetId);
    const rows = await assetsAt(s.shopId);
    expect(rows.map((r) => r.status).sort()).toEqual(['ACTIVE', 'DELETED']);
  });

  it('S31 AS-27: a base from the future is refused', async () => {
    const s = await t.seller();
    await t.save(s, '/m.txt', t.randomBytes(10_000));
    await t.save(s, '/m.txt', t.randomBytes(10_000), { baseVersion: 1 });
    const before = await seqs(s.shopId);
    const res = await t.save(s, '/m.txt', t.randomBytes(10_000), {
      baseVersion: 5,
    });
    expect(res.commit.status).toBe(422);
    expect(res.commit.body).toMatchObject({
      code: 'invalid_base_version',
      currentVersion: 2,
    });
    expect(await seqs(s.shopId)).toEqual(before);
    expect((await assetsAt(s.shopId))[0].currentVersion).toBe(2);
  });

  // ---------------------------------------------------------------------------------------------- journal

  it('S31 AS-28: the journal is read in pages by cursor', async () => {
    const s = await t.seller();
    const start = await syncCursor(s);
    for (let i = 0; i < 5; i++)
      await t.commitEmpty(s, `/file-${i}.txt`).expect(201);
    const read = (cursor: string) =>
      t
        .http()
        .get(`/api/shops/${s.shopId}/assets/changes`)
        .query({ cursor, limit: 2 })
        .set(s.auth)
        .expect(200);

    const p1 = await read(start);
    const p2 = await read(p1.body.nextCursor);
    const p3 = await read(p2.body.nextCursor);
    const pages = [p1, p2, p3].map((p) =>
      expectContract(assetChangePageSchema, p.body),
    );
    expect(pages.map((p) => p.items.map((i) => i.seq))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    for (const item of pages.flatMap((p) => p.items))
      expect(item.kind).toBe('upsert');
    const empty = await read(p3.body.nextCursor);
    expect(empty.body).toMatchObject({
      items: [],
      hasMore: false,
      nextCursor: p3.body.nextCursor,
    });
  });

  it('S31 AS-29: 20 commits at once get consecutive numbers without gaps', async () => {
    const s = await t.seller();
    await t.commitEmpty(s, '/seed.txt').expect(201);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        t.commitEmpty(s, `/parallel-${i}.txt`),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    expect(await seqs(s.shopId)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1),
    );
  });

  it('S31 AS-30: a missing, malformed or future cursor and bad limits are refused', async () => {
    const s = await t.seller();
    const get = (query: Record<string, unknown>) =>
      t
        .http()
        .get(`/api/shops/${s.shopId}/assets/changes`)
        .query(query)
        .set(s.auth);
    expect((await get({}).expect(400)).body.code).toBe('validation_failed');
    expect((await get({ cursor: 'not a cursor!' }).expect(422)).body.code).toBe(
      'invalid_cursor',
    );
    expect((await get({ cursor: 'bm90LW9uZQ' }).expect(422)).body.code).toBe(
      'invalid_cursor',
    );
    const future = Buffer.from('v1:journal:999').toString('base64url');
    expect((await get({ cursor: future }).expect(422)).body.code).toBe(
      'invalid_cursor',
    );
    const ok = Buffer.from('v1:journal:0').toString('base64url');
    expect((await get({ cursor: ok, limit: 0 }).expect(400)).body.code).toBe(
      'validation_failed',
    );
    expect((await get({ cursor: ok, limit: 1001 }).expect(400)).body.code).toBe(
      'validation_failed',
    );
    await get({ cursor: ok, limit: 1000 }).expect(200);
  });

  // ---------------------------------------------------------------------------------------------- listing

  it('S31 AS-31: the listing pages by path, hides deleted and foreign assets and escapes the prefix', async () => {
    const s = await t.seller();
    const other = await t.seller();
    const paths = [
      '/kits/a.txt',
      '/kits/b.txt',
      '/kits/c.txt',
      '/p%/x.txt',
      '/pa/y.txt',
      '/p_/z.txt',
      '/zeta.txt',
    ];
    for (const p of paths) await t.commitEmpty(s, p).expect(201);
    await t.commitEmpty(other, '/kits/foreign.txt').expect(201);
    const gone = await t.commitEmpty(s, '/kits/deleted.txt').expect(201);
    await t
      .http()
      .delete(`/api/shops/${s.shopId}/assets/${gone.body.assetId}`)
      .set(s.auth)
      .expect(204);

    const page = (query: Record<string, unknown>) =>
      t
        .http()
        .get(`/api/shops/${s.shopId}/assets`)
        .query(query)
        .set(s.auth)
        .expect(200);
    const p1 = await page({ limit: 3 });
    const p2 = await page({ limit: 3, cursor: p1.body.nextCursor });
    const p3 = await page({ limit: 3, cursor: p2.body.nextCursor });
    const parsed = [p1, p2, p3].map((p) =>
      expectContract(assetPageSchema, p.body),
    );
    expect(parsed.map((p) => p.items.length)).toEqual([3, 3, 1]);
    const all = parsed.flatMap((p) => p.items.map((i) => i.path));
    // byte order: '%' (0x25) sorts before '_' (0x5f) and both before letters
    expect(all).toEqual([...paths].sort());
    expect(all.indexOf('/p%/x.txt')).toBeLessThan(all.indexOf('/pa/y.txt'));
    expect(new Set(all).size).toBe(7);
    expect(parsed[0].syncCursor).not.toBeNull();
    expect(parsed[1].syncCursor).toBeNull();
    expect(parsed[2].nextCursor).toBeNull();

    const kits = await page({ prefix: '/kits/' });
    expect(kits.body.items.map((i: { path: string }) => i.path)).toEqual([
      '/kits/a.txt',
      '/kits/b.txt',
      '/kits/c.txt',
    ]);
    const percent = await page({ prefix: '/p%/' });
    expect(percent.body.items.map((i: { path: string }) => i.path)).toEqual([
      '/p%/x.txt',
    ]);
    const underscore = await page({ prefix: '/p_/' });
    expect(underscore.body.items.map((i: { path: string }) => i.path)).toEqual([
      '/p_/z.txt',
    ]);

    const deleted = await page({ deleted: 'true' });
    expect(deleted.body.items).toEqual([
      expect.objectContaining({ path: '/kits/deleted.txt', status: 'DELETED' }),
    ]);
    expect(deleted.body.items[0].deletedAt).not.toBeNull();
    for (const limit of [0, 101])
      expect(
        (
          await t
            .http()
            .get(`/api/shops/${s.shopId}/assets`)
            .query({ limit })
            .set(s.auth)
            .expect(400)
        ).body.code,
      ).toBe('validation_failed');
    await t
      .http()
      .get(`/api/shops/${s.shopId}/assets`)
      .query({ cursor: 'garbage' })
      .set(s.auth)
      .expect(422);
  });

  // ---------------------------------------------------------------------------------------------- manifest

  it('S31 AS-32: the manifest pages chunk URLs and every URL gives the bytes', async () => {
    const s = await t.seller();
    const pieces = Array.from({ length: 5 }, (_, i) =>
      randomBytes(5_000 + i * 100),
    );
    const refs = pieces.map((b) => ({ hash: sha(b), size: b.length }));
    const prep = await t.prepare(s, refs).expect(200);
    const whole = Buffer.concat(pieces);
    let offset = 0;
    await t.putMissing(
      prep,
      whole,
      pieces.map((b) => {
        const c = { offset, length: b.length, hash: sha(b) };
        offset += b.length;
        return c;
      }),
    );
    const v1 = await t
      .commit(s, {
        path: '/five.bin',
        baseVersion: 0,
        chunks: refs.map((r) => r.hash),
        sizeBytes: whole.length,
        deviceId: 'laptop-1',
      })
      .expect(201);
    const id = v1.body.assetId as string;
    const v2 = await t.save(s, '/five.bin', t.randomBytes(9_000), {
      baseVersion: 1,
    });
    expect(v2.commit.body.version).toBe(2);

    const pageAt = (query: Record<string, unknown>) =>
      t
        .http()
        .get(`/api/shops/${s.shopId}/assets/${id}/manifest`)
        .query(query)
        .set(s.auth);
    const m1 = expectContract(
      assetManifestSchema,
      (await pageAt({ version: 1, from: 0, limit: 2 }).expect(200)).body,
    );
    const m2 = expectContract(
      assetManifestSchema,
      (await pageAt({ version: 1, from: m1.nextFrom!, limit: 2 }).expect(200))
        .body,
    );
    const m3 = expectContract(
      assetManifestSchema,
      (await pageAt({ version: 1, from: m2.nextFrom!, limit: 2 }).expect(200))
        .body,
    );
    expect([m1, m2, m3].map((m) => m.chunks.map((c) => c.index))).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
    expect([m1.nextFrom, m2.nextFrom, m3.nextFrom]).toEqual([2, 4, null]);
    expect(m1.totalChunks).toBe(5);
    for (const [i, c] of [...m1.chunks, ...m2.chunks, ...m3.chunks].entries()) {
      expect(c).toMatchObject({ hash: refs[i].hash, sizeBytes: refs[i].size });
      expect(c.url).toMatch(/X-Amz-Expires=600/);
    }
    expect((await t.download(s, id, 1)).equals(whole)).toBe(true);
    const current = await pageAt({}).expect(200);
    expect(current.body.version).toBe(2);
    expect((await pageAt({ version: 9 }).expect(404)).body.code).toBe(
      'version_not_found',
    );
    expect((await pageAt({ version: 'x' }).expect(400)).body.code).toBe(
      'validation_failed',
    );
    expect((await pageAt({ limit: 2001 }).expect(400)).body.code).toBe(
      'validation_failed',
    );
    await t
      .http()
      .delete(`/api/shops/${s.shopId}/assets/${id}`)
      .set(s.auth)
      .expect(204);
    expect((await pageAt({}).expect(404)).body.code).toBe('asset_not_found');
  });

  // ---------------------------------------------------------------------------------------------- notification

  it('S31 AS-33: exactly one notification per journaled change, none for an unchanged save', async () => {
    const s = await t.seller();
    const bytes = t.randomBytes(10_000);
    const created = await t.save(s, '/n.txt', bytes);
    const updated = await t.save(s, '/n.txt', t.randomBytes(10_000), {
      baseVersion: 1,
    });
    const copy = await t.save(s, '/n.txt', t.randomBytes(10_000), {
      baseVersion: 1,
      deviceId: 'phone-2',
    });
    expect([created, updated, copy].map((r) => r.commit.body.outcome)).toEqual([
      'created',
      'updated',
      'conflicted_copy',
    ]);
    const unchanged = await t.save(s, '/n.txt', updated.bytes, {
      baseVersion: 2,
    });
    expect(unchanged.commit.body.outcome).toBe('unchanged');
    const id = created.commit.body.assetId as string;
    await t
      .http()
      .post(`/api/shops/${s.shopId}/assets/${id}/versions/1/restore`)
      .set(s.auth)
      .send({ baseVersion: 2 })
      .expect(201);
    await t
      .http()
      .delete(`/api/shops/${s.shopId}/assets/${id}`)
      .set(s.auth)
      .expect(204);
    await t
      .http()
      .post(`/api/shops/${s.shopId}/assets/${id}/undelete`)
      .set(s.auth)
      .expect(200);

    const events = t.hub.of(s.shopId);
    expect(events.map((e) => (e.data as { lastSeq: number }).lastSeq)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    for (const e of events)
      expect(e).toMatchObject({
        type: 'assets.changed',
        topic: `shop:${s.shopId}:assets`,
      });
    expect(await seqs(s.shopId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each(['down', 'throws'] as const)(
    'S31 AS-33: with the hub %s a commit still succeeds, the journal keeps the change and the failure is counted',
    async (mode) => {
      const s = await t.seller();
      t.hub.mode = mode;
      const before = failures();
      const res = await t.commitEmpty(s, '/hub.txt').expect(201);
      expect(res.body.outcome).toBe('created');
      expect(await seqs(s.shopId)).toEqual([1]);
      expect(failures()).toBe(before + 1);
      expect(t.hub.of(s.shopId)).toEqual([]);
    },
  );
});
