import { createHash, randomBytes } from 'node:crypto';
import { v4 } from 'uuid';
import {
  assetCommitResponseSchema,
  assetPrepareResponseSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { chunkKey } from './infra/chunk-store';
import { CleanupService } from './application/cleanup.service';
import {
  createAssetApp,
  expectContract,
  type AssetTestApp,
  type Seller,
} from './testing/asset-client';

const MiB = 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hex = () => randomBytes(32).toString('hex');

describe('Asset library: prepare, dedupe, commit, quota and idempotency', () => {
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

  const chunkRows = (shopId: string) =>
    t.rows<{
      hash: string;
      size: number;
      refCount: number;
      storedAt: Date | null;
      reserved: boolean;
    }>(
      `SELECT "hash", "size", "refCount", "storedAt", "reserved" FROM "AssetChunk" WHERE "shopId" = :shopId ORDER BY "hash"`,
      { shopId },
    );
  const journal = (shopId: string) =>
    t.rows<{ seq: string; kind: string; version: number; path: string }>(
      `SELECT "seq", "kind", "version", "path" FROM "AssetChange" WHERE "shopId" = :shopId ORDER BY "seq"`,
      { shopId },
    );
  const versionsOf = (shopId: string) =>
    t.rows<{ assetId: string; version: number; chunks: string[] }>(
      `SELECT v."assetId", v."version", v."chunks" FROM "AssetVersion" v JOIN "Asset" a ON a."id" = v."assetId" WHERE a."shopId" = :shopId ORDER BY v."assetId", v."version"`,
      { shopId },
    );
  const assetsOf = (shopId: string) =>
    t.rows<{
      id: string;
      path: string;
      status: string;
      currentVersion: number;
    }>(
      `SELECT "id", "path", "status", "currentVersion" FROM "Asset" WHERE "shopId" = :shopId ORDER BY "path"`,
      { shopId },
    );
  const counter = (name: string, labels = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;

  /** One chunk of `size` random bytes, hashed as a whole (bypasses the chunker). */
  const single = (size: number) => {
    const bytes = randomBytes(size);
    return {
      bytes,
      chunk: { offset: 0, length: size, hash: sha(bytes) },
      ref: { hash: sha(bytes), size },
    };
  };

  // ---------------------------------------------------------------------------------------------------- prepare

  it('S31 AS-01: prepare returns only what is missing, with 900 s permissions bound to hash and size', async () => {
    const s = await t.seller();
    const bytes = t.randomBytes(100_000);
    const chunks = t.chunksOf(bytes);
    const refs = chunks.map((c) => ({ hash: c.hash, size: c.length }));

    const first = await t.prepare(s, refs).expect(200);
    const body = expectContract(assetPrepareResponseSchema, first.body);
    expect(body.alreadyStored).toBe(0);
    expect(body.missing.map((m) => m.hash).sort()).toEqual(
      [...new Set(chunks.map((c) => c.hash))].sort(),
    );
    for (const m of body.missing) {
      const c = chunks.find((x) => x.hash === m.hash)!;
      expect(m.url).toContain(`assets/${s.shopId}/chunks/${m.hash}`);
      expect(m.headers['x-amz-checksum-sha256']).toBe(
        Buffer.from(m.hash, 'hex').toString('base64'),
      );
      expect(Number(m.headers['content-length'])).toBe(c.length);
      expect(new Date(m.expiresAt).getTime()).toBe(
        t.clock.now().getTime() + 900_000,
      );
    }
    const reserved = await chunkRows(s.shopId);
    expect(reserved.every((r) => r.reserved && r.storedAt === null)).toBe(true);

    await t.putMissing(first, bytes, chunks);
    await t
      .commit(s, {
        path: '/kits/brand-guide.pdf',
        baseVersion: 0,
        chunks: chunks.map((c) => c.hash),
        sizeBytes: bytes.length,
        deviceId: 'laptop-1',
      })
      .expect(201);
    const again = await t.prepare(s, refs).expect(200);
    expect(again.body.missing).toEqual([]);
    expect(again.body.alreadyStored).toBe(body.missing.length);
  });

  it('S31 AS-02: duplicates collapse, files share chunks, and shops never see each other', async () => {
    const s1 = await t.seller();
    const s2 = await t.seller();
    const c1 = single(5_000);
    const c2 = single(6_000);
    const dup = await t.prepare(s1, [c1.ref, c1.ref, c2.ref]).expect(200);
    expect(dup.body.missing).toHaveLength(2);
    expect(dup.body.alreadyStored).toBe(0);

    // /x holds c1..c3, /y reuses c2 and c3
    const c3 = single(7_000);
    const c7 = single(8_000);
    const prep = await t.prepare(s1, [c1.ref, c2.ref, c3.ref]).expect(200);
    await t.putMissing(prep, Buffer.concat([c1.bytes, c2.bytes, c3.bytes]), [
      { ...c1.chunk, offset: 0 },
      { ...c2.chunk, offset: c1.bytes.length },
      { ...c3.chunk, offset: c1.bytes.length + c2.bytes.length },
    ]);
    await t
      .commit(s1, {
        path: '/x',
        baseVersion: 0,
        chunks: [c1.ref.hash, c2.ref.hash, c3.ref.hash],
        sizeBytes: 18_000,
        deviceId: 'laptop-1',
      })
      .expect(201);
    const y = await t.prepare(s1, [c2.ref, c3.ref, c7.ref]).expect(200);
    expect(y.body.missing.map((m: { hash: string }) => m.hash)).toEqual([
      c7.ref.hash,
    ]);

    const before = await chunkRows(s1.shopId);
    const other = await t.prepare(s2, [c1.ref, c2.ref, c3.ref]).expect(200);
    expect(other.body.missing).toHaveLength(3);
    expect(other.body.alreadyStored).toBe(0);
    for (const m of other.body.missing as { url: string }[])
      expect(m.url).toContain(`assets/${s2.shopId}/chunks/`);
    expect(await chunkRows(s1.shopId)).toEqual(before);
  });

  const hash = hex();
  it.each([
    ['a 63-character hash', { chunks: [{ hash: hash.slice(1), size: 10 }] }],
    ['a 65-character hash', { chunks: [{ hash: `${hash}a`, size: 10 }] }],
    [
      'an upper-case hash',
      {
        chunks: [
          { hash: hash.toUpperCase().replace(/[A-F]/g, 'A') + 'F', size: 10 },
        ],
      },
    ],
    ['a non-hex hash', { chunks: [{ hash: `${hash.slice(1)}z`, size: 10 }] }],
    ['size 0', { chunks: [{ hash, size: 0 }] }],
    ['size -1', { chunks: [{ hash, size: -1 }] }],
    ['size 1.5', { chunks: [{ hash, size: 1.5 }] }],
    ['a string size', { chunks: [{ hash, size: '10' }] }],
    ['size 16 MiB + 1', { chunks: [{ hash, size: 16 * MiB + 1 }] }],
    ['no chunks', { chunks: [] }],
    ['an unknown property', { chunks: [{ hash, size: 10 }], extra: 1 }],
    ['an unknown chunk property', { chunks: [{ hash, size: 10, extra: 1 }] }],
    ['no body', undefined],
  ])('S31 AS-03: %s answers 400 and persists nothing', async (_name, body) => {
    const s = await t.seller();
    const res = await t
      .http()
      .post(`/api/shops/${s.shopId}/assets/prepare`)
      .set(s.auth)
      .send(body as object | undefined)
      .expect(400);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors?.length).toBeGreaterThan(0);
    expect(await chunkRows(s.shopId)).toEqual([]);
  });

  it('S31 AS-03: 5,000 chunks and a 16 MiB size are accepted', async () => {
    const s = await t.seller();
    const many = Array.from({ length: 5_000 }, () => ({
      hash: hex(),
      size: 1,
    }));
    const res = await t.prepare(s, many).expect(200);
    expect(res.body.missing).toHaveLength(5_000);
    await t.prepare(s, [{ hash: hex(), size: 16 * MiB }]).expect(200);
    await t.prepare(s, [...many, { hash: hex(), size: 1 }]).expect(400);
  }, 120_000);

  it('S31 AS-04: one hash has one size', async () => {
    const s = await t.seller();
    const c = single(4_096);
    const prep = await t.prepare(s, [c.ref]).expect(200);
    await t.putMissing(prep, c.bytes, [c.chunk]);
    await t
      .commit(s, {
        path: '/a',
        baseVersion: 0,
        chunks: [c.ref.hash],
        sizeBytes: 4_096,
        deviceId: 'laptop-1',
      })
      .expect(201);
    const before = await chunkRows(s.shopId);
    const res = await t
      .prepare(s, [{ hash: c.ref.hash, size: 5_000 }])
      .expect(422);
    expect(res.body.code).toBe('chunk_size_mismatch');
    expect(res.body.hash).toBe(c.ref.hash);
    expect(await chunkRows(s.shopId)).toEqual(before);
  });

  it('S31 AS-05: stored means confirmed in storage', async () => {
    const s = await t.seller();
    const c = single(9_000);
    const first = await t.prepare(s, [c.ref]).expect(200);
    await t.advance(10 * 60_000);
    const tenMin = await t.prepare(s, [c.ref]).expect(200);
    expect(tenMin.body.missing).toHaveLength(1);
    expect(tenMin.body.alreadyStored).toBe(0);
    expect(
      new Date(tenMin.body.missing[0].expiresAt).getTime(),
    ).toBeGreaterThan(new Date(first.body.missing[0].expiresAt).getTime());
    await t.advance(3 * 3_600_000);
    const later = await t.prepare(s, [c.ref]).expect(200);
    expect(later.body.missing).toHaveLength(1);
    expect(later.body.alreadyStored).toBe(0);

    await t.putMissing(later, c.bytes, [c.chunk]);
    const done = await t.prepare(s, [c.ref]).expect(200);
    expect(done.body.missing).toEqual([]);
    expect(done.body.alreadyStored).toBe(1);
  });

  it('S31 AS-06: storage itself refuses bytes that do not match the permission', async () => {
    const s = await t.seller();
    const c = single(20_000);
    const prep = await t.prepare(s, [c.ref]).expect(200);
    const m = prep.body.missing[0] as {
      url: string;
      headers: Record<string, string>;
    };
    const { 'content-length': _l, ...headers } = m.headers;
    const wrongBytes = await fetch(m.url, {
      method: 'PUT',
      headers,
      body: randomBytes(20_000),
    });
    expect(wrongBytes.status).toBeGreaterThanOrEqual(400);
    expect(wrongBytes.status).toBeLessThan(500);
    const wrongLength = await fetch(m.url, {
      method: 'PUT',
      headers,
      body: c.bytes.subarray(0, 19_999),
    });
    expect(wrongLength.status).toBeGreaterThanOrEqual(400);
    expect(wrongLength.status).toBeLessThan(500);

    const refused = await t
      .commit(s, {
        path: '/a',
        baseVersion: 0,
        chunks: [c.ref.hash],
        sizeBytes: 20_000,
        deviceId: 'laptop-1',
      })
      .expect(422);
    expect(refused.body.code).toBe('chunk_not_uploaded');
    expect(refused.body.hashes).toEqual([c.ref.hash]);

    await t.putMissing(prep, c.bytes, [c.chunk]);
    await t
      .commit(s, {
        path: '/a',
        baseVersion: 0,
        chunks: [c.ref.hash],
        sizeBytes: 20_000,
        deviceId: 'laptop-1',
      })
      .expect(201);

    // a permission whose time passed is refused by storage
    const other = single(1_000);
    const short = await t.storage.presignPutChecked(
      chunkKey(s.shopId, other.ref.hash),
      other.ref.hash,
      1_000,
      1,
    );
    await new Promise((r) => setTimeout(r, 2_200));
    const { 'content-length': _x, ...shortHeaders } = short.headers;
    const expired = await fetch(short.url, {
      method: 'PUT',
      headers: shortHeaders,
      body: other.bytes,
    });
    expect(expired.status).toBeGreaterThanOrEqual(400);
  });

  // ---------------------------------------------------------------------------------------------------- commit

  it('S31 AS-07: a commit creates the first version, journals it and notifies once', async () => {
    const s = await t.seller();
    const bytes = t.randomBytes(100_000);
    const saved = await t.save(s, '/kits/brand-guide.pdf', bytes);
    expect(saved.commit.status).toBe(201);
    const body = expectContract(assetCommitResponseSchema, saved.commit.body);
    expect(body).toMatchObject({
      path: '/kits/brand-guide.pdf',
      version: 1,
      outcome: 'created',
      conflicted: false,
      sizeBytes: bytes.length,
    });
    const assets = await assetsOf(s.shopId);
    expect(assets).toEqual([
      {
        id: body.assetId,
        path: '/kits/brand-guide.pdf',
        status: 'ACTIVE',
        currentVersion: 1,
      },
    ]);
    const versions = await versionsOf(s.shopId);
    expect(versions).toHaveLength(1);
    expect(versions[0].chunks).toEqual(saved.chunks.map((c) => c.hash));
    const [row] = await t.rows<{ createdBy: string }>(
      `SELECT "createdBy" FROM "AssetVersion" WHERE "assetId" = :id`,
      { id: body.assetId },
    );
    expect(row.createdBy).toBe(s.id);
    const occurrences = new Map<string, number>();
    for (const c of saved.chunks)
      occurrences.set(c.hash, (occurrences.get(c.hash) ?? 0) + 1);
    for (const r of await chunkRows(s.shopId))
      expect(r.refCount).toBe(occurrences.get(r.hash));
    expect(await journal(s.shopId)).toEqual([
      { seq: '1', kind: 'upsert', version: 1, path: '/kits/brand-guide.pdf' },
    ]);
    expect(t.hub.of(s.shopId)).toEqual([
      {
        topic: `shop:${s.shopId}:assets`,
        type: 'assets.changed',
        data: { lastSeq: 1 },
      },
    ]);
  });

  it('S31 AS-08: after a 20-byte insertion at most 3 chunks travel and the edit downloads byte-identical', async () => {
    const s = await t.seller();
    const original = t.randomBytes(1 * MiB);
    const first = await t.save(s, '/big.bin', original);
    expect(first.commit.status).toBe(201);
    const edited = Buffer.concat([
      original.subarray(0, 600_000),
      Buffer.from('twenty bytes inserted'.slice(0, 20)),
      original.subarray(600_000),
    ]);
    const second = await t.save(s, '/big.bin', edited, { baseVersion: 1 });
    expect(second.prepare.body.missing.length).toBeLessThanOrEqual(3);
    expect(second.commit.status).toBe(201);
    expect(second.commit.body).toMatchObject({
      version: 2,
      outcome: 'updated',
      conflicted: false,
    });

    const firstHashes = new Set(first.chunks.map((c) => c.hash));
    const counts = new Map<string, number>();
    for (const c of [...first.chunks, ...second.chunks])
      counts.set(c.hash, (counts.get(c.hash) ?? 0) + 1);
    for (const r of await chunkRows(s.shopId)) {
      expect(r.refCount).toBe(counts.get(r.hash));
      if (
        firstHashes.has(r.hash) &&
        second.chunks.some((c) => c.hash === r.hash)
      )
        expect(r.refCount).toBeGreaterThanOrEqual(2);
    }
    const downloaded = await t.download(s, second.commit.body.assetId);
    expect(downloaded.equals(edited)).toBe(true);
    expect((await journal(s.shopId)).map((j) => j.seq)).toEqual(['1', '2']);
  }, 120_000);

  describe('S31 AS-09 commit validation', () => {
    const goodChunk = single(4_096);
    const valid = (over: Record<string, unknown> = {}) => ({
      path: '/ok.txt',
      baseVersion: 0,
      chunks: [goodChunk.ref.hash],
      sizeBytes: 4_096,
      deviceId: 'laptop-1',
      ...over,
    });
    const longPath = `/${'a'.repeat(200)}`.repeat(6);
    it.each([
      ['a path without a leading slash', valid({ path: 'ok.txt' })],
      ['a path with //', valid({ path: '/a//b' })],
      ['a path with a . segment', valid({ path: '/a/./b' })],
      ['a path with a .. segment', valid({ path: '/a/../b' })],
      ['a path ending with /', valid({ path: '/a/' })],
      ['a path with NUL', valid({ path: '/a\u0000b' })],
      ['a path with a backslash', valid({ path: '/a\\b' })],
      ['a path with a control character', valid({ path: '/a\u0007b' })],
      ['a path over 1,000 characters', valid({ path: longPath })],
      ['a segment over 255 characters', valid({ path: `/${'a'.repeat(256)}` })],
      [
        '15,001 chunks',
        valid({ chunks: Array.from({ length: 15_001 }, () => hex()) }),
      ],
      [
        'an upper-case chunk hash',
        valid({ chunks: [hex().toUpperCase().replace(/[0-9]/g, 'A')] }),
      ],
      ['a short chunk hash', valid({ chunks: ['abc'] })],
      ['a negative size', valid({ sizeBytes: -1 })],
      ['a fractional size', valid({ sizeBytes: 1.5 })],
      ['a size over 50 GiB', valid({ sizeBytes: 53_687_091_201 })],
      ['a negative base version', valid({ baseVersion: -1 })],
      ['a fractional base version', valid({ baseVersion: 1.5 })],
      ['a device id of 3 characters', valid({ deviceId: 'abc' })],
      ['a device id with a space', valid({ deviceId: 'my phone' })],
      ['an unknown property', valid({ extra: true })],
    ])('%s answers 400 and persists nothing', async (_name, body) => {
      const s = await t.seller();
      const res = await t.commit(s, body).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(await assetsOf(s.shopId)).toEqual([]);
      expect(await versionsOf(s.shopId)).toEqual([]);
      expect(await journal(s.shopId)).toEqual([]);
    });

    it.each([
      ['missing', undefined, 'idempotency_key_required'],
      ['shorter than 8 characters', 'short12', 'idempotency_key_invalid'],
      [
        'longer than 128 characters',
        'k'.repeat(129),
        'idempotency_key_invalid',
      ],
      ['containing a space', 'key with space', 'idempotency_key_invalid'],
    ])(
      'an Idempotency-Key that is %s answers 422',
      async (_name, key, code) => {
        const s = await t.seller();
        let req = t
          .http()
          .post(`/api/shops/${s.shopId}/assets/commit`)
          .set(s.auth);
        if (key !== undefined) req = req.set('Idempotency-Key', key);
        const res = await req.send(valid()).expect(422);
        expect(res.body.code).toBe(code);
        expect(await assetsOf(s.shopId)).toEqual([]);
      },
    );

    it('exactly 15,000 chunks pass validation and commit', async () => {
      const s = await t.seller();
      const c = single(4_096);
      const prep = await t.prepare(s, [c.ref]).expect(200);
      await t.putMissing(prep, c.bytes, [c.chunk]);
      const res = await t
        .commit(s, {
          path: '/many.bin',
          baseVersion: 0,
          chunks: Array.from({ length: 15_000 }, () => c.ref.hash),
          sizeBytes: 15_000 * 4_096,
          deviceId: 'laptop-1',
        })
        .expect(201);
      expect(res.body.sizeBytes).toBe(15_000 * 4_096);
      const [r] = await chunkRows(s.shopId);
      expect(r.refCount).toBe(15_000);
    }, 120_000);

    it('exactly 50 GiB passes validation and commits', async () => {
      const s = await t.seller();
      const c = single(16 * MiB);
      const prep = await t.prepare(s, [c.ref]).expect(200);
      await t.putMissing(prep, c.bytes, [c.chunk]);
      const res = await t
        .commit(s, {
          path: '/fifty.bin',
          baseVersion: 0,
          chunks: Array.from({ length: 3_200 }, () => c.ref.hash),
          sizeBytes: 53_687_091_200,
          deviceId: 'laptop-1',
        })
        .expect(201);
      expect(res.body.sizeBytes).toBe(53_687_091_200);
    }, 120_000);
  });

  it('S31 AS-10: a commit refuses what it cannot prove and persists nothing', async () => {
    const s1 = await t.seller();
    const s2 = await t.seller();
    const never = single(3_000);
    const prepared = single(3_100);
    await t.prepare(s1, [prepared.ref]).expect(200);
    const foreign = single(3_200);
    const foreignPrep = await t.prepare(s2, [foreign.ref]).expect(200);
    await t.putMissing(foreignPrep, foreign.bytes, [foreign.chunk]);
    const real = single(3_300);
    const realPrep = await t.prepare(s1, [real.ref]).expect(200);
    await t.putMissing(realPrep, real.bytes, [real.chunk]);

    const body = (chunks: string[], sizeBytes: number) => ({
      path: '/a',
      baseVersion: 0,
      chunks,
      sizeBytes,
      deviceId: 'laptop-1',
    });
    const unknown = await t
      .commit(s1, body([never.ref.hash], 3_000))
      .expect(422);
    expect(unknown.body).toMatchObject({
      code: 'chunks_unknown',
      hashes: [never.ref.hash],
    });
    const notUp = await t
      .commit(s1, body([prepared.ref.hash], 3_100))
      .expect(422);
    expect(notUp.body).toMatchObject({
      code: 'chunk_not_uploaded',
      hashes: [prepared.ref.hash],
    });
    const otherShop = await t
      .commit(s1, body([foreign.ref.hash], 3_200))
      .expect(422);
    expect(otherShop.body).toMatchObject({
      code: 'chunks_unknown',
      hashes: [foreign.ref.hash],
    });
    const size = await t.commit(s1, body([real.ref.hash], 9_999)).expect(422);
    expect(size.body).toMatchObject({
      code: 'size_mismatch',
      expectedBytes: 9_999,
      actualBytes: 3_300,
    });

    expect(await assetsOf(s1.shopId)).toEqual([]);
    expect(await versionsOf(s1.shopId)).toEqual([]);
    expect(await journal(s1.shopId)).toEqual([]);
    for (const r of await chunkRows(s1.shopId)) expect(r.refCount).toBe(0);
  });

  it('S31 AS-11: an empty file is a valid version', async () => {
    const s = await t.seller();
    const res = await t
      .commit(s, {
        path: '/.gitkeep',
        baseVersion: 0,
        chunks: [],
        sizeBytes: 0,
        deviceId: 'laptop-1',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      version: 1,
      outcome: 'created',
      sizeBytes: 0,
    });
    const manifest = await t
      .http()
      .get(`/api/shops/${s.shopId}/assets/${res.body.assetId}/manifest`)
      .set(s.auth)
      .expect(200);
    expect(manifest.body.chunks).toEqual([]);
    expect(manifest.body.totalChunks).toBe(0);
    expect((await t.download(s, res.body.assetId)).length).toBe(0);
    const bad = await t
      .commit(s, {
        path: '/five',
        baseVersion: 0,
        chunks: [],
        sizeBytes: 5,
        deviceId: 'laptop-1',
      })
      .expect(422);
    expect(bad.body.code).toBe('size_mismatch');
  });

  describe('S31 AS-12 idempotent commit', () => {
    it('replays the stored answer with the replay header and creates one version', async () => {
      const s = await t.seller();
      const bytes = t.randomBytes(50_000);
      const chunks = t.chunksOf(bytes);
      const prep = await t
        .prepare(
          s,
          chunks.map((c) => ({ hash: c.hash, size: c.length })),
        )
        .expect(200);
      await t.putMissing(prep, bytes, chunks);
      const body = {
        path: '/m.txt',
        baseVersion: 0,
        chunks: chunks.map((c) => c.hash),
        sizeBytes: bytes.length,
        deviceId: 'laptop-1',
      };
      const first = await t.commit(s, body, 'key-aaaa-1111').expect(201);
      const replay = await t.commit(s, body, 'key-aaaa-1111').expect(201);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(await assetsOf(s.shopId)).toHaveLength(1);
      expect(await versionsOf(s.shopId)).toHaveLength(1);
      expect((await journal(s.shopId)).length).toBe(1);
    });

    it('answers 409 while the same key is still in flight, 422 for another body', async () => {
      const s = await t.seller();
      const bytes = t.randomBytes(30_000);
      const chunks = t.chunksOf(bytes);
      const prep = await t
        .prepare(
          s,
          chunks.map((c) => ({ hash: c.hash, size: c.length })),
        )
        .expect(200);
      await t.putMissing(prep, bytes, chunks);
      const body = {
        path: '/gate.txt',
        baseVersion: 0,
        chunks: chunks.map((c) => c.hash),
        sizeBytes: bytes.length,
        deviceId: 'laptop-1',
      };
      t.store.closeGate();
      const first = t.commit(s, body, 'key-gate-0001').then((r) => r);
      await t.store.waitingAtGate;
      const inFlight = await t.commit(s, body, 'key-gate-0001').expect(409);
      expect(inFlight.body.code).toBe('idempotency_in_flight');
      expect(inFlight.headers['retry-after']).toBe('1');
      t.store.openGate();
      expect((await first).status).toBe(201);

      const reused = await t
        .commit(s, { ...body, path: '/other.txt' }, 'key-gate-0001')
        .expect(422);
      expect(reused.body.code).toBe('idempotency_key_reuse');
      expect(await assetsOf(s.shopId)).toHaveLength(1);
    });

    it('scopes a key per shop and user, and forgets it after 24 hours', async () => {
      const a = await t.seller();
      const b = await t.seller();
      const colleague = await t.member(a.shopId, 'ADMIN');
      const c = single(4_096);
      const send = async (who: Seller, path: string) => {
        const prep = await t.prepare(who, [c.ref]).expect(200);
        await t.putMissing(prep, c.bytes, [c.chunk]);
        return t.commit(
          who,
          {
            path,
            baseVersion: 0,
            chunks: [c.ref.hash],
            sizeBytes: 4_096,
            deviceId: 'laptop-1',
          },
          'shared-key-01',
        );
      };
      const first = await send(a, '/one');
      expect(first.status).toBe(201);
      const otherShop = await send(b, '/one');
      expect(otherShop.status).toBe(201);
      expect(otherShop.headers['idempotency-replayed']).toBeUndefined();
      const otherUser = await t
        .commit(
          { ...colleague, shopId: a.shopId },
          {
            path: '/two',
            baseVersion: 0,
            chunks: [c.ref.hash],
            sizeBytes: 4_096,
            deviceId: 'phone-2',
          },
          'shared-key-01',
        )
        .expect(201);
      expect(otherUser.headers['idempotency-replayed']).toBeUndefined();

      await t.advance(24 * 3_600_000 + 1_000);
      const prep = await t.prepare(a, [c.ref]).expect(200);
      expect(prep.status).toBe(200);
      const expired = await t.commit(
        a,
        {
          path: '/one',
          baseVersion: 0,
          chunks: [c.ref.hash],
          sizeBytes: 4_096,
          deviceId: 'laptop-1',
        },
        'shared-key-01',
      );
      expect(expired.headers['idempotency-replayed']).toBeUndefined();
      expect(expired.status).toBe(201);
      expect(expired.body.outcome).toBe('conflicted_copy');
    });
  });

  it('S31 AS-13: a save that changes nothing adds nothing', async () => {
    const s = await t.seller();
    const v1 = t.randomBytes(40_000);
    const one = await t.save(s, '/a.txt', v1);
    const v2 = Buffer.concat([v1, t.randomBytes(5_000)]);
    await t.save(s, '/a.txt', v2, { baseVersion: 1 });
    const v3 = Buffer.concat([v2, t.randomBytes(5_000)]);
    const three = await t.save(s, '/a.txt', v3, { baseVersion: 2 });
    expect(three.commit.body.version).toBe(3);
    const beforeRows = await chunkRows(s.shopId);
    const events = t.hub.of(s.shopId).length;

    const same = await t.save(s, '/a.txt', v3, { baseVersion: 3 });
    expect(same.commit.status).toBe(200);
    expectContract(assetCommitResponseSchema, same.commit.body);
    expect(same.commit.body).toMatchObject({
      version: 3,
      outcome: 'unchanged',
      assetId: one.commit.body.assetId,
    });
    expect(await versionsOf(s.shopId)).toHaveLength(3);
    expect(await journal(s.shopId)).toHaveLength(3);
    expect(await chunkRows(s.shopId)).toEqual(beforeRows);
    expect(t.hub.of(s.shopId)).toHaveLength(events);
  });

  it('S31 AS-16: no storage call happens while a transaction holds chunk rows', async () => {
    const s = await t.seller();
    const bytes = t.randomBytes(30_000);
    const chunks = t.chunksOf(bytes);
    const prep = await t
      .prepare(
        s,
        chunks.map((c) => ({ hash: c.hash, size: c.length })),
      )
      .expect(200);
    await t.putMissing(prep, bytes, chunks);
    t.store.closeGate();
    const commit = t
      .commit(s, {
        path: '/gated.bin',
        baseVersion: 0,
        chunks: chunks.map((c) => c.hash),
        sizeBytes: bytes.length,
        deviceId: 'laptop-1',
      })
      .then((r) => r);
    await t.store.waitingAtGate;
    // a probe for a row lock on the chunk records must not wait: nobody holds one during the storage call
    await t.db.transaction(async () => {
      await t.db.query(
        `SELECT "hash" FROM "AssetChunk" WHERE "shopId" = :shopId FOR UPDATE NOWAIT`,
        { replacements: { shopId: s.shopId } },
      );
    });
    t.store.openGate();
    expect((await commit).status).toBe(201);
  });

  it('S31 AS-17: storage unavailable at commit answers 503 and persists nothing', async () => {
    const s = await t.seller();
    const bytes = t.randomBytes(30_000);
    const chunks = t.chunksOf(bytes);
    const prep = await t
      .prepare(
        s,
        chunks.map((c) => ({ hash: c.hash, size: c.length })),
      )
      .expect(200);
    await t.putMissing(prep, bytes, chunks);
    const body = {
      path: '/down.bin',
      baseVersion: 0,
      chunks: chunks.map((c) => c.hash),
      sizeBytes: bytes.length,
      deviceId: 'laptop-1',
    };
    const failures = counter('assets_storage_failures_total', {
      operation: 'head',
    });
    t.store.failNext('exists');
    const res = await t.commit(s, body, 'key-down-0001').expect(503);
    expect(res.body.code).toBe('storage_unavailable');
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body.detail).not.toMatch(/inject|ECONN|minio|s3/i);
    expect(await assetsOf(s.shopId)).toEqual([]);
    expect(await versionsOf(s.shopId)).toEqual([]);
    expect(
      counter('assets_storage_failures_total', { operation: 'head' }),
    ).toBe(failures + 1);

    t.store.heal();
    await t.commit(s, body, 'key-down-0001').expect(201);
  });

  it('S31 AS-18: the 121st upload call within a minute answers 429, other shops are free', async () => {
    const s = await t.seller();
    const other = await t.seller();
    for (let i = 0; i < 120; i++)
      await t.prepare(s, [{ hash: hex(), size: 1 }]).expect(200);
    const before = await chunkRows(s.shopId);
    const limited = await t.prepare(s, [{ hash: hex(), size: 1 }]).expect(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await t
      .commit(s, {
        path: '/a',
        baseVersion: 0,
        chunks: [],
        sizeBytes: 0,
        deviceId: 'laptop-1',
      })
      .expect(429);
    expect(await chunkRows(s.shopId)).toEqual(before);
    expect(await assetsOf(s.shopId)).toEqual([]);
    await t.prepare(other, [{ hash: hex(), size: 1 }]).expect(200);
    await t.http().get(`/api/shops/${s.shopId}/assets`).set(s.auth).expect(200);
  }, 120_000);
});

describe('Asset library: storage quota', () => {
  let t: AssetTestApp;
  const quota = 10 * MiB;
  beforeAll(async () => {
    t = await createAssetApp({ config: { quotaBytes: quota } });
  });
  afterAll(async () => {
    await t.close();
  });

  const usage = async (shopId: string) => {
    const [row] = await t.rows<{ storedBytes: string; reservedBytes: string }>(
      `SELECT "storedBytes", "reservedBytes" FROM "AssetShopUsage" WHERE "shopId" = :shopId`,
      { shopId },
    );
    return Number(row.storedBytes) + Number(row.reservedBytes);
  };
  const piece = (size: number) => {
    const bytes = randomBytes(size);
    const hash = sha(bytes);
    return {
      bytes,
      hash,
      ref: { hash, size },
      chunk: { offset: 0, length: size, hash },
    };
  };

  it('S31 AS-14: new bytes beyond the quota are refused, held bytes never are, and freed space is usable', async () => {
    const s = await t.seller();
    const big = piece(quota - 1_000);
    const prep = await t.prepare(s, [big.ref]).expect(200);
    await t.putMissing(prep, big.bytes, [big.chunk]);
    await t
      .commit(s, {
        path: '/big',
        baseVersion: 0,
        chunks: [big.hash],
        sizeBytes: big.ref.size,
        deviceId: 'laptop-1',
      })
      .expect(201);
    expect(await usage(s.shopId)).toBe(quota - 1_000);

    const refused = await t
      .prepare(s, [{ hash: hex(), size: 2_000 }])
      .expect(409);
    expect(refused.body).toMatchObject({
      code: 'quota_exceeded',
      limitBytes: quota,
      usedBytes: quota - 1_000,
    });
    expect(await usage(s.shopId)).toBe(quota - 1_000);

    const held = await t.prepare(s, [big.ref]).expect(200);
    expect(held.body.alreadyStored).toBe(1);

    // a second version replaces the first; deleting the first and waiting out the grace frees the bytes
    const small = piece(500);
    const prep2 = await t.prepare(s, [small.ref]).expect(200);
    await t.putMissing(prep2, small.bytes, [small.chunk]);
    await t
      .commit(s, {
        path: '/big',
        baseVersion: 1,
        chunks: [small.hash],
        sizeBytes: 500,
        deviceId: 'laptop-1',
      })
      .expect(201);
    const asset = (
      await t.rows<{ id: string }>(
        `SELECT "id" FROM "Asset" WHERE "shopId" = :id`,
        { id: s.shopId },
      )
    )[0];
    await t
      .http()
      .delete(`/api/shops/${s.shopId}/assets/${asset.id}/versions/1`)
      .set(s.auth)
      .expect(204);
    await t.advance(25 * 3_600_000);
    await t.app.get(CleanupService, { strict: false }).collectChunks();
    expect(await usage(s.shopId)).toBe(500);
    await t.prepare(s, [{ hash: hex(), size: 2_000 }]).expect(200);
  }, 120_000);

  it('S31 AS-15: two concurrent prepares never overshoot the quota', async () => {
    const s = await t.seller();
    // the quota is 10 MiB and nothing is used: two prepares of 6 MiB of new chunks cannot both fit
    const results = await Promise.all([
      t.prepare(s, [{ hash: hex(), size: 6 * MiB }]),
      t.prepare(s, [{ hash: hex(), size: 6 * MiB }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await usage(s.shopId)).toBeLessThanOrEqual(quota);
  });
});
