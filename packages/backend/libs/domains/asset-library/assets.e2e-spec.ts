import { createAssetApp, type AssetTestApp } from './testing/asset-client';

/** Whole-flow smoke of the asset library over HTTP; each scenario is proven in depth by its own capability spec. */
describe('S31 asset library: end-to-end flows', () => {
  let t: AssetTestApp;
  beforeAll(async () => {
    t = await createAssetApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('S31 AS-21: editing the middle of a file uploads only the changed chunks and the new version downloads byte-identical', async () => {
    const s = await t.seller();
    const v1 = t.randomBytes(1024 * 1024);
    const first = await t.save(s, '/kits/brand-guide.pdf', v1);
    expect(first.commit.status).toBe(201);
    expect((await t.download(s, first.commit.body.assetId)).equals(v1)).toBe(
      true,
    );

    const v2 = Buffer.concat([
      v1.subarray(0, 600_000),
      Buffer.from('revised pricing page'),
      v1.subarray(600_000),
    ]);
    const second = await t.save(s, '/kits/brand-guide.pdf', v2, {
      baseVersion: 1,
    });
    expect(second.commit.body).toMatchObject({ version: 2, conflicted: false });
    const known = new Set(first.chunks.map((c) => c.hash));
    expect(
      second.chunks.filter((c) => !known.has(c.hash)).length,
    ).toBeLessThanOrEqual(3);
    expect((await t.download(s, second.commit.body.assetId)).equals(v2)).toBe(
      true,
    );
  });

  it('S31 AS-21: two devices editing the same version: the second save becomes a conflicted copy, nothing is lost', async () => {
    const s = await t.seller();
    const base = t.randomBytes(100_000);
    await t.save(s, '/manual.txt', base);
    const a = Buffer.concat([base, Buffer.from('A')]);
    const b = Buffer.concat([base, Buffer.from('B')]);
    const laptop = await t.save(s, '/manual.txt', a, {
      baseVersion: 1,
      deviceId: 'laptop-1',
    });
    expect(laptop.commit.body.conflicted).toBe(false);
    const phone = await t.save(s, '/manual.txt', b, {
      baseVersion: 1,
      deviceId: 'phone-2',
    });
    expect(phone.commit.body.conflicted).toBe(true);
    expect(phone.commit.body.path).toMatch(
      /^\/manual \(conflicted copy phone-2 \d{4}-\d{2}-\d{2}\)\.txt$/,
    );
    expect((await t.download(s, laptop.commit.body.assetId)).equals(a)).toBe(
      true,
    );
    expect((await t.download(s, phone.commit.body.assetId)).equals(b)).toBe(
      true,
    );
  });

  it('S31 AS-35: deleting a version keeps the chunks another version uses, so the current version still downloads', async () => {
    const s = await t.seller();
    const v1 = t.randomBytes(300_000);
    const first = await t.save(s, '/a.bin', v1);
    const v2 = Buffer.concat([
      v1.subarray(0, 150_000),
      t.randomBytes(50_000),
      v1.subarray(150_000),
    ]);
    const second = await t.save(s, '/a.bin', v2, { baseVersion: 1 });
    const id = first.commit.body.assetId as string;
    expect(second.commit.body.assetId).toBe(id);
    await t
      .http()
      .delete(`/api/shops/${s.shopId}/assets/${id}/versions/1`)
      .set(s.auth)
      .expect(204);
    expect((await t.download(s, id)).equals(v2)).toBe(true);
  });

  it('S31 AS-48: a share link honours its download cap', async () => {
    const s = await t.seller();
    const saved = await t.save(s, '/press-kit.zip', t.randomBytes(20_000));
    const assetId = saved.commit.body.assetId as string;
    const link = await t
      .http()
      .post(`/api/shops/${s.shopId}/assets/${assetId}/share`)
      .set(s.auth)
      .send({ expiresInHours: 24, maxDownloads: 1 });
    expect(link.status).toBe(201);
    const redeem = () =>
      t.http().post(`/api/assets/shared/${link.body.token}/redeem`);
    expect((await redeem()).status).toBe(200);
    expect((await redeem()).status).toBe(410);
  });

  it('S31 AS-01: a second prepare of stored chunks lists nothing missing', async () => {
    const s = await t.seller();
    const saved = await t.save(s, '/dedupe.bin', t.randomBytes(80_000));
    const again = await t.prepare(
      s,
      saved.chunks.map((c) => ({ hash: c.hash, size: c.length })),
    );
    expect(again.status).toBe(200);
    expect(again.body.missing).toEqual([]);
    expect(again.body.alreadyStored).toBe(saved.chunks.length);
  });
});
