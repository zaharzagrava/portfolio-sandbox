import { createHash } from 'node:crypto';
import { v4 } from 'uuid';
import {
  shareLinkListSchema,
  shareLinkPreviewSchema,
  shareLinkSchema,
  shareRedeemSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ScriptLoader } from '@app/infrastructure/rate-limit/script-loader';
import {
  createAssetApp,
  expectContract,
  USERCONTENT_ORIGIN as ORIGIN,
  type AssetTestApp,
  type Seller,
} from './testing/asset-client';

const HOUR = 3_600_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const pathOf = (url: string) => new URL(url).pathname;

interface Answer {
  status: number;

  body: any;
  headers: Record<string, string | string[] | undefined>;
  bytes: Buffer;
  complete: boolean;
}

describe('Asset library: share links and download delivery', () => {
  let t: AssetTestApp;
  /** Anonymous calls come from this address (through the trusted proxy), one fresh address per test: the limit is per address. */
  let me = '';
  let next = 1;
  beforeAll(async () => {
    t = await createAssetApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    me = `203.0.113.${next++}`;
  });
  afterEach(() => {
    t.store.heal();
    jest.restoreAllMocks();
  });

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    forwardedFor = me,
  ): Promise<Answer> => {
    const r = await (method === 'GET' ? t.rawGet : t.rawPost)(path, {
      forwardedFor,
    });
    let body: unknown;
    try {
      body = JSON.parse(r.body.toString());
    } catch {
      body = undefined;
    }
    return {
      status: r.status,
      body,
      headers: r.headers,
      bytes: r.body,
      complete: r.complete,
    };
  };
  const preview = (token: string, addr?: string) =>
    call('GET', `/api/assets/shared/${token}`, addr);
  const redeem = (token: string, addr?: string) =>
    call('POST', `/api/assets/shared/${token}/redeem`, addr);
  const fetchUrl = (url: string, addr?: string) =>
    call('GET', pathOf(url), addr);
  const ok = (answer: Answer, status = 200) => {
    expect(answer.status).toBe(status);
    return answer;
  };

  /** An asset with `bytes`, and a link on it. */
  async function shared(
    over: {
      path?: string;
      bytes?: Buffer;
      expiresInHours?: number;
      maxDownloads?: number;
    } = {},
  ) {
    const s = await t.seller();
    const bytes = over.bytes ?? t.randomBytes(30_000);
    const saved = await t.save(s, over.path ?? '/press/kit.zip', bytes);
    const assetId = saved.commit.body.assetId as string;
    const link = await create(s, assetId, {
      expiresInHours: over.expiresInHours ?? 24,
      ...(over.maxDownloads ? { maxDownloads: over.maxDownloads } : {}),
    });
    return { s, bytes, assetId, link: link.body, saved };
  }
  const create = (s: Seller, assetId: string, body: object) =>
    t
      .http()
      .post(`/api/shops/${s.shopId}/assets/${assetId}/share`)
      .set(s.auth)
      .send(body);
  const linkRow = async (id: string) =>
    (
      await t.rows<{
        downloads: number;
        revokedAt: Date | null;
        tokenHash: string;
      }>(
        `SELECT "downloads", "revokedAt", "tokenHash" FROM "AssetShareLink" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const significant = (b: Record<string, unknown>) => ({
    type: b.type,
    title: b.title,
    status: b.status,
    detail: b.detail,
    code: b.code,
  });
  const counter = (name: string, labels: Record<string, string>) =>
    MetricsRegistry.value(name, labels) ?? 0;

  // ------------------------------------------------------------------------------------------ create and list

  it('S31 AS-46: a link is created with a token, a user-content URL and only its digest stored', async () => {
    const s = await t.seller();
    const saved = await t.save(s, '/press/kit.zip', t.randomBytes(10_000));
    const assetId = saved.commit.body.assetId as string;
    const res = await create(s, assetId, {
      expiresInHours: 24,
      maxDownloads: 3,
    }).expect(201);
    const link = expectContract(shareLinkSchema, res.body);
    expect(link.token.length).toBeGreaterThanOrEqual(32);
    expect(link.url).toBe(`${ORIGIN}/assets/shared/${link.token}`);
    expect(new URL(link.url).origin).not.toBe(
      new URL('http://localhost:8400').origin,
    );
    expect(link.maxDownloads).toBe(3);
    expect(new Date(link.expiresAt).getTime()).toBe(
      t.clock.now().getTime() + 24 * HOUR,
    );

    const row = await linkRow(link.id);
    expect(row.tokenHash).toBe(sha(link.token));
    const [raw] = await t.rows<{ doc: string }>(
      `SELECT row_to_json(l)::text AS doc FROM "AssetShareLink" l WHERE "id" = :id`,
      { id: link.id },
    );
    expect(raw.doc).not.toContain(link.token);

    const list = await t
      .http()
      .get(`/api/shops/${s.shopId}/assets/${assetId}/share-links`)
      .set(s.auth)
      .expect(200);
    const parsed = expectContract(shareLinkListSchema, list.body);
    expect(parsed.items).toEqual([
      expect.objectContaining({
        id: link.id,
        maxDownloads: 3,
        downloads: 0,
        status: 'ACTIVE',
        createdBy: s.id,
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain(link.token);

    const stranger = await t.seller();
    expect(
      (await create(stranger, assetId, { expiresInHours: 1 }).expect(404)).body
        .code,
    ).toBe('asset_not_found');
    await t
      .http()
      .delete(`/api/shops/${s.shopId}/assets/${assetId}`)
      .set(s.auth)
      .expect(204);
    expect(
      (await create(s, assetId, { expiresInHours: 1 }).expect(404)).body.code,
    ).toBe('asset_not_found');
    await t
      .http()
      .get(`/api/shops/${s.shopId}/assets/${assetId}/share-links`)
      .set(s.auth)
      .expect(404);
  });

  it.each([
    ['expiresInHours 0', { expiresInHours: 0 }],
    ['expiresInHours 721', { expiresInHours: 721 }],
    ['expiresInHours 1.5', { expiresInHours: 1.5 }],
    ['a string expiresInHours', { expiresInHours: '24' }],
    ['no expiresInHours', {}],
    ['maxDownloads 0', { expiresInHours: 24, maxDownloads: 0 }],
    ['maxDownloads 10001', { expiresInHours: 24, maxDownloads: 10_001 }],
    ['maxDownloads 1.5', { expiresInHours: 24, maxDownloads: 1.5 }],
    ['a string maxDownloads', { expiresInHours: 24, maxDownloads: '3' }],
    ['an unknown property', { expiresInHours: 24, extra: 1 }],
  ])('S31 AS-47: %s answers 400', async (_name, body) => {
    const s = await t.seller();
    const saved = await t.save(s, '/a.bin', t.randomBytes(5_000));
    const res = await create(s, saved.commit.body.assetId, body).expect(400);
    expect(res.body.code).toBe('validation_failed');
  });

  it('S31 AS-47: the limits themselves are accepted', async () => {
    const s = await t.seller();
    const saved = await t.save(s, '/a.bin', t.randomBytes(5_000));
    const id = saved.commit.body.assetId;
    await create(s, id, { expiresInHours: 720, maxDownloads: 10_000 }).expect(
      201,
    );
    const open = await create(s, id, { expiresInHours: 1 }).expect(201);
    expect(open.body.maxDownloads).toBeNull();
  });

  // ------------------------------------------------------------------------------------- preview and redeem

  it('S31 AS-48: a preview never counts, and every unavailable reason answers the same body', async () => {
    const x = await shared({ maxDownloads: 3 });
    for (let i = 0; i < 5; i++) {
      const res = ok(await preview(x.link.token));
      const body = expectContract(shareLinkPreviewSchema, res.body);
      expect(body).toMatchObject({
        fileName: 'kit.zip',
        sizeBytes: x.bytes.length,
        remainingDownloads: 3,
      });
    }
    expect((await linkRow(x.link.id)).downloads).toBe(0);

    const bodies: Record<string, unknown>[] = [];
    const gone = async (token: string) => {
      const res = await preview(token);
      expect(res.status).toBe(410);
      bodies.push(significant(res.body));
    };
    await gone(v4().replace(/-/g, '')); // unknown
    const expired = await shared({ expiresInHours: 1 });
    await t.advance(2 * HOUR);
    await gone(expired.link.token);
    const revoked = await shared();
    await t
      .http()
      .delete(
        `/api/shops/${revoked.s.shopId}/assets/${revoked.assetId}/share-links/${revoked.link.id}`,
      )
      .set(revoked.s.auth)
      .expect(204);
    await gone(revoked.link.token);
    const exhausted = await shared({ maxDownloads: 1 });
    ok(await redeem(exhausted.link.token));
    await gone(exhausted.link.token);
    const removed = await shared();
    await t
      .http()
      .delete(`/api/shops/${removed.s.shopId}/assets/${removed.assetId}`)
      .set(removed.s.auth)
      .expect(204);
    await gone(removed.link.token);
    expect(bodies).toHaveLength(5);
    for (const b of bodies) {
      expect(b).toEqual(bodies[0]);
      expect(b.code).toBe('link_unavailable');
    }
  });

  it('S31 AS-49: redeem counts once, the download URL serves the bytes and dies after 120 seconds', async () => {
    const x = await shared();
    const grant = expectContract(
      shareRedeemSchema,
      ok(await redeem(x.link.token)).body,
    );
    expect(grant).toMatchObject({
      fileName: 'kit.zip',
      sizeBytes: x.bytes.length,
    });
    expect(new Date(grant.expiresAt).getTime()).toBe(
      t.clock.now().getTime() + 120_000,
    );
    expect(grant.url.startsWith(`${ORIGIN}/api/downloads/`)).toBe(true);
    expect((await linkRow(x.link.id)).downloads).toBe(1);

    expect(ok(await fetchUrl(grant.url)).bytes.equals(x.bytes)).toBe(true);
    expect(ok(await fetchUrl(grant.url)).bytes.equals(x.bytes)).toBe(true);
    expect((await linkRow(x.link.id)).downloads).toBe(1);

    await t.advance(121_000);
    const late = await fetchUrl(grant.url);
    expect(late.status).toBe(410);
    expect(late.body.code).toBe('download_unavailable');
  });

  it('S31 AS-50: the cap holds when ten people click at once', async () => {
    const x = await shared({ maxDownloads: 3 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => redeem(x.link.token)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      200, 200, 200, 410, 410, 410, 410, 410, 410, 410,
    ]);
    expect((await linkRow(x.link.id)).downloads).toBe(3);
    expect((await redeem(x.link.token)).status).toBe(410);
    expect((await linkRow(x.link.id)).downloads).toBe(3);
  });

  it('S31 AS-51: a link is valid up to but not at its expiry', async () => {
    const x = await shared({ expiresInHours: 2 });
    const expiresAt = t.clock.now().getTime() + 2 * HOUR;
    await t.setTime(new Date(expiresAt - 1_000));
    ok(await preview(x.link.token));
    ok(await redeem(x.link.token));
    await t.setTime(new Date(expiresAt));
    ok(await preview(x.link.token), 410);
    expect(ok(await redeem(x.link.token), 410).body.code).toBe(
      'link_unavailable',
    );
  });

  it('S31 AS-52: a revoked link, and the URLs it issued, stop working', async () => {
    const x = await shared();
    const grant = ok(await redeem(x.link.token)).body;
    const url = `/api/shops/${x.s.shopId}/assets/${x.assetId}/share-links/${x.link.id}`;
    await t.http().delete(url).set(x.s.auth).expect(204);
    const list = await t
      .http()
      .get(`/api/shops/${x.s.shopId}/assets/${x.assetId}/share-links`)
      .set(x.s.auth)
      .expect(200);
    expect(list.body.items[0].status).toBe('REVOKED');
    ok(await redeem(x.link.token), 410);
    const outstanding = ok(await fetchUrl(grant.url), 410);
    expect(outstanding.body.code).toBe('download_unavailable');
    expect(
      (await t.http().delete(url).set(x.s.auth).expect(409)).body.code,
    ).toBe('invalid_transition');

    const other = await t.seller();
    const mine = await t.save(other, '/mine.bin', t.randomBytes(5_000));
    const foreign = `/api/shops/${other.shopId}/assets/${mine.commit.body.assetId}/share-links/${x.link.id}`;
    expect(
      (await t.http().delete(foreign).set(other.auth).expect(404)).body.code,
    ).toBe('share_link_not_found');
    const crossed = `/api/shops/${other.shopId}/assets/${x.assetId}/share-links/${x.link.id}`;
    expect(
      (await t.http().delete(crossed).set(other.auth).expect(404)).body.code,
    ).toBe('asset_not_found');
  });

  it('S31 AS-53: a deleted file cannot be redeemed and the attempt costs nothing', async () => {
    const x = await shared({ maxDownloads: 2 });
    await t
      .http()
      .delete(`/api/shops/${x.s.shopId}/assets/${x.assetId}`)
      .set(x.s.auth)
      .expect(204);
    ok(await preview(x.link.token), 410);
    ok(await redeem(x.link.token), 410);
    expect((await linkRow(x.link.id)).downloads).toBe(0);
    await t
      .http()
      .post(`/api/shops/${x.s.shopId}/assets/${x.assetId}/undelete`)
      .set(x.s.auth)
      .expect(200);
    ok(await preview(x.link.token));
    ok(await redeem(x.link.token));
    expect((await linkRow(x.link.id)).downloads).toBe(1);
  });

  it('S31 AS-54: a link serves the latest version, and an issued URL keeps its own', async () => {
    const x = await shared();
    const v2 = t.randomBytes(20_000);
    await t.save(x.s, '/press/kit.zip', v2, { baseVersion: 1 });
    const first = ok(await redeem(x.link.token)).body;
    expect(ok(await fetchUrl(first.url)).bytes.equals(v2)).toBe(true);
    const v3 = t.randomBytes(20_000);
    await t.save(x.s, '/press/kit.zip', v3, { baseVersion: 2 });
    expect(ok(await fetchUrl(first.url)).bytes.equals(v2)).toBe(true);
    const nextGrant = ok(await redeem(x.link.token)).body;
    expect(ok(await fetchUrl(nextGrant.url)).bytes.equals(v3)).toBe(true);
  });

  it('S31 AS-55: files are delivered as safe attachments', async () => {
    const x = await shared({
      path: '/promo/pic.svg',
      bytes: Buffer.from('<svg onload="alert(1)"/>'),
    });
    const grant = ok(await redeem(x.link.token)).body;
    const res = ok(await fetchUrl(grant.url));
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(x.bytes.length));
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="pic.svg"; filename*=UTF-8''pic.svg`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.bytes.equals(x.bytes)).toBe(true);
  });

  it('S31 AS-57: a storage failure before the first byte is a clean 503, after it the connection is cut', async () => {
    const x = await shared({ bytes: t.randomBytes(200_000) });
    const grant = ok(await redeem(x.link.token)).body;
    t.store.failNext('open', 1, x.s.shopId);
    const refused = ok(await fetchUrl(grant.url), 503);
    expect(refused.headers['content-disposition']).toBeUndefined();
    expect(refused.body.code).toBe('storage_unavailable');
    expect(refused.bytes.toString()).not.toMatch(/inject|minio|s3|stack/i);

    const aborted = counter('assets_download_total', {
      kind: 'share',
      outcome: 'aborted',
    });
    t.store.failNext('open', 1, x.s.shopId, 1);
    const cut = await fetchUrl(grant.url);
    expect(cut.status).toBe(200);
    expect(cut.complete).toBe(false);
    expect(cut.bytes.length).toBeLessThan(x.bytes.length);
    expect(
      counter('assets_download_total', { kind: 'share', outcome: 'aborted' }),
    ).toBe(aborted + 1);
    expect(cut.bytes.toString()).not.toMatch(/inject|stack/i);
  });

  it('S31 AS-58: the 61st anonymous call from one address within a minute answers 429', async () => {
    const x = await shared({ maxDownloads: 5 });
    const grant = ok(await redeem(x.link.token)).body; // 1 of 60 for this address
    for (let i = 0; i < 29; i++) ok(await preview(x.link.token));
    for (let i = 0; i < 30; i++) ok(await fetchUrl(grant.url));
    const before = (await linkRow(x.link.id)).downloads;
    const limited = ok(await redeem(x.link.token), 429);
    expect(limited.body.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await linkRow(x.link.id)).downloads).toBe(before);
    ok(await preview(x.link.token, '198.51.100.250'));
    ok(await redeem(x.link.token, '198.51.100.250'));
    expect((await linkRow(x.link.id)).downloads).toBe(before + 1);
  }, 60_000);

  it('S31 AS-58: with the limiter store down an open policy lets the call through', async () => {
    const x = await shared();
    const scripts = t.app.get(ScriptLoader, { strict: false });
    jest.spyOn(scripts, 'run').mockRejectedValue(new Error('store down'));
    ok(await preview(x.link.token, '198.51.100.77'));
  });
});
