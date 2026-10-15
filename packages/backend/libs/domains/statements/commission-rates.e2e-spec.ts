import { v4 as uuidv4 } from 'uuid';
import {
  commissionRateAsOfSchema,
  commissionRateChangeResultSchema,
  commissionRateHistoryPageSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { TestUser } from '@app/test/utils/catalog-app';
import { createStatementsApp, type StatementsTestApp } from './testing/statements-app';

const ZERO = '00000000-0000-0000-0000-000000000000';
const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Statements: bitemporal commission rates', () => {
  let t: StatementsTestApp;
  let admin: TestUser;
  let shopA: string;
  let owner: TestUser;

  beforeAll(async () => {
    t = await createStatementsApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date('2026-04-01T09:00:00Z'));
    admin = await t.admin();
    ({ shopId: shopA, owner } = await t.shopWithOwner());
  });

  /** A session only lives 15 minutes of the fake clock: moving the clock far needs a new session. */
  const setNow = async (iso: string) => {
    t.clock.set(new Date(iso));
    admin = await t.admin();
  };

  const post = (
    body: Record<string, unknown>,
    options: { key?: string | null; who?: TestUser | null } = {},
  ) => {
    const who = options.who === undefined ? admin : options.who;
    let req = who
      ? t.as(who).post('/api/admin/commission-rates')
      : t.http().post('/api/admin/commission-rates');
    if (options.key !== null) req = req.set('Idempotency-Key', options.key ?? uuidv4());
    return req.send(body);
  };
  const get = (url: string, who: TestUser | null = admin) =>
    who ? t.as(who).get(`/api${url}`) : t.http().get(`/api${url}`);

  const rows = (where = 'true') =>
    t.sql<{
      id: string;
      changeId: string;
      shopKey: string;
      category: string;
      rateBps: number;
      reason: string;
      recordedBy: string | null;
      validFrom: string | null;
      validTo: string | null;
      recordedFrom: string;
      recordedTo: string | null;
      empty: boolean;
    }>(
      `SELECT id, "changeId", "shopKey", category, "rateBps", reason, "recordedBy",
              lower("validPeriod")::text AS "validFrom", upper("validPeriod")::text AS "validTo",
              lower("recordedPeriod")::text AS "recordedFrom", upper("recordedPeriod")::text AS "recordedTo",
              isempty("recordedPeriod") AS empty
         FROM "CommissionRate" WHERE ${where} ORDER BY lower("recordedPeriod"), id`,
    );
  const total = async () => (await rows()).length;
  const electronicsBody = (extra: Record<string, unknown> = {}) => ({
    shopId: shopA,
    category: 'electronics',
    rateBps: 700,
    validFrom: '2026-03-01T00:00:00Z',
    reason: 'promo-2026-03',
    ...extra,
  });

  it('S16 AS-01: an admin sets a rate and the new belief is the only addition', async () => {
    const before = await total();
    const res = await post(electronicsBody());
    expect(res.status).toBe(201);
    const body = commissionRateChangeResultSchema.parse(res.body);
    expect(body).toMatchObject({
      shopId: shopA,
      category: 'electronics',
      rateBps: 700,
      validTo: null,
      changed: true,
      affectedClosedMonths: [],
    });
    expect(Date.parse(body.validFrom)).toBe(Date.parse('2026-03-01T00:00:00Z'));
    expect(Date.parse(body.recordedAt)).toBe(Date.parse('2026-04-01T09:00:00Z'));

    const added = await rows(`"shopKey" = '${shopA}'`);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      changeId: body.changeId,
      category: 'electronics',
      rateBps: 700,
      reason: 'promo-2026-03',
      recordedBy: admin.id,
      recordedTo: null,
    });
    expect(Date.parse(added[0].recordedFrom)).toBe(Date.parse('2026-04-01T09:00:00Z'));
    expect(await total()).toBe(before + 1);
    const defaults = await rows(`"shopKey" = '${ZERO}'`);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].recordedTo).toBeNull();
    expect(metric('statements_rate_changes_total', { outcome: 'recorded' })).toBeGreaterThan(0);
  });

  describe('lookup and history on both axes', () => {
    beforeEach(async () => {
      await setNow('2026-01-01T00:00:00Z');
      expect(
        (
          await post({
            category: 'electronics',
            rateBps: 800,
            validFrom: '2026-01-01T00:00:00Z',
            reason: 'base',
          })
        ).status,
      ).toBe(201);
      await setNow('2026-04-10T00:00:00Z');
      expect(
        (
          await post({
            category: 'electronics',
            rateBps: 750,
            validFrom: '2026-06-01T00:00:00Z',
            reason: 'summer',
          })
        ).status,
      ).toBe(201);
    });

    it.each([
      ['2026-07-01T00:00:00Z', '2026-04-01T00:00:00Z', 'electronics', 800, 'default_category'],
      ['2026-07-01T00:00:00Z', undefined, 'electronics', 750, 'default_category'],
      ['2026-03-01T00:00:00Z', undefined, 'electronics', 800, 'default_category'],
      ['2025-12-01T00:00:00Z', undefined, 'electronics', 1000, 'default_any'],
    ])(
      'S16 AS-02: validAt %s knownAt %s resolves to %i by %s',
      async (validAt, knownAt, category, rateBps, rule) => {
        const res = await get(
          `/admin/commission-rates/as-of?category=${category}&validAt=${validAt}${knownAt ? `&knownAt=${knownAt}` : ''}`,
        );
        expect(res.status).toBe(200);
        const body = commissionRateAsOfSchema.parse(res.body);
        expect(body.rateBps).toBe(rateBps);
        expect(body.rule).toBe(rule);
      },
    );

    it('S16 AS-03: the history keeps three beliefs and only closes one recorded period', async () => {
      const res = await get('/admin/commission-rates?category=electronics');
      expect(res.status).toBe(200);
      const page = commissionRateHistoryPageSchema.parse(res.body);
      expect(page.items).toHaveLength(3);
      const original = page.items.find((i) => i.rateBps === 800 && i.recordedTo !== null)!;
      const remainder = page.items.find((i) => i.rateBps === 800 && i.recordedTo === null)!;
      const summer = page.items.find((i) => i.rateBps === 750)!;
      expect(Date.parse(original.recordedFrom!)).toBe(Date.parse('2026-01-01T00:00:00Z'));
      expect(Date.parse(original.recordedTo!)).toBe(Date.parse('2026-04-10T00:00:00Z'));
      expect(original.validTo).toBeNull();
      expect(Date.parse(remainder.validFrom!)).toBe(Date.parse('2026-01-01T00:00:00Z'));
      expect(Date.parse(remainder.validTo!)).toBe(Date.parse('2026-06-01T00:00:00Z'));
      expect(Date.parse(remainder.recordedFrom!)).toBe(Date.parse('2026-04-10T00:00:00Z'));
      expect(Date.parse(summer.validFrom!)).toBe(Date.parse('2026-06-01T00:00:00Z'));
      expect(summer.validTo).toBeNull();
      expect(original.changeId).toBe(remainder.changeId);
      expect(summer.changeId).not.toBe(original.changeId);
    });
  });

  it('S16 AS-05: the store itself refuses a second current belief with overlapping validity', async () => {
    const first = await post(electronicsBody({ category: 'x', validTo: '2026-03-01T00:00:00Z', validFrom: '2026-01-01T00:00:00Z' }));
    expect(first.status).toBe(201);
    const before = await total();
    await expect(
      t.sequelize.query(
        `INSERT INTO "CommissionRate" ("shopKey", category, "rateBps", "validPeriod", "recordedPeriod", reason)
         VALUES (:shop, 'x', 500, tstzrange('2026-02-01T00:00:00Z', NULL), tstzrange(now(), NULL), 'privileged')`,
        { replacements: { shop: shopA } },
      ),
    ).rejects.toMatchObject({ parent: { code: '23P01' } });
    expect(await total()).toBe(before);
  });

  it('S16 AS-06: two admins changing overlapping ranges are serialised with distinct record instants', async () => {
    const other = await t.admin();
    const [one, two] = await Promise.all([
      post(electronicsBody({ rateBps: 600, validFrom: '2026-03-01T00:00:00Z', validTo: '2026-05-01T00:00:00Z' })),
      post(electronicsBody({ rateBps: 650, validFrom: '2026-04-01T00:00:00Z' }), { who: other }),
    ]);
    expect([one.status, two.status]).toEqual([201, 201]);
    const ids = [one.body.changeId, two.body.changeId];
    expect(new Set(ids).size).toBe(2);

    const [overlaps] = await t.sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "CommissionRate" a JOIN "CommissionRate" b
         ON a.id < b.id AND a."shopKey" = b."shopKey" AND a.category = b.category AND a."validPeriod" && b."validPeriod"
        WHERE upper_inf(a."recordedPeriod") AND upper_inf(b."recordedPeriod")`,
    );
    expect(overlaps.n).toBe('0');
    const mine = await rows(`"shopKey" = '${shopA}' AND category = 'electronics'`);
    expect(mine.every((r) => !r.empty)).toBe(true);
    const recordedForChange = ids.map((id) =>
      mine.find((r) => r.changeId === id)!.recordedFrom,
    );
    expect(new Set(recordedForChange).size).toBe(2);
    const history = commissionRateHistoryPageSchema.parse(
      (await get(`/admin/commission-rates?shopId=${shopA}&category=electronics`)).body,
    );
    expect(ids.every((id) => history.items.some((i) => i.changeId === id))).toBe(true);
  });

  it('S16 AS-07: two changes at one frozen instant are recorded a microsecond apart', async () => {
    const first = await post(electronicsBody({ rateBps: 600 }));
    const second = await post(electronicsBody({ rateBps: 650 }));
    expect([first.status, second.status]).toEqual([201, 201]);
    const mine = await rows(`"shopKey" = '${shopA}' AND category = 'electronics'`);
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => !r.empty)).toBe(true);
    const [gap] = await t.sql<{ micros: string }>(
      `SELECT (extract(epoch FROM (SELECT max(lower("recordedPeriod")) FROM "CommissionRate" WHERE "shopKey" = :s)
                - (SELECT min(lower("recordedPeriod")) FROM "CommissionRate" WHERE "shopKey" = :s)) * 1000000)::bigint::text AS micros`,
      { s: shopA },
    );
    expect(Number(gap.micros)).toBe(1);
  });

  it('S16 AS-08: the same change again is a no-op that writes nothing', async () => {
    expect((await post(electronicsBody())).status).toBe(201);
    const before = await total();
    const [{ jobs: jobsBefore }] = await t.sql<{ jobs: string }>(`SELECT count(*)::text AS jobs FROM "Job"`);
    const [{ events: eventsBefore }] = await t.sql<{ events: string }>(`SELECT count(*)::text AS events FROM "Outbox"`);

    const res = await post(electronicsBody());
    expect(res.status).toBe(200);
    expect(commissionRateChangeResultSchema.parse(res.body).changed).toBe(false);
    expect(await total()).toBe(before);
    const [{ jobs }] = await t.sql<{ jobs: string }>(`SELECT count(*)::text AS jobs FROM "Job"`);
    const [{ events }] = await t.sql<{ events: string }>(`SELECT count(*)::text AS events FROM "Outbox"`);
    expect(jobs).toBe(jobsBefore);
    expect(events).toBe(eventsBefore);
    expect(metric('statements_rate_changes_total', { outcome: 'noop' })).toBeGreaterThan(0);
  });

  describe('S16 AS-09 validation', () => {
    it.each([
      ['rateBps -1', { rateBps: -1 }],
      ['rateBps 10001', { rateBps: 10001 }],
      ['rateBps 7.5', { rateBps: 7.5 }],
      ['rateBps "7"', { rateBps: '7' }],
      ['empty category', { category: '' }],
      ['65-character category', { category: 'c'.repeat(65) }],
      ['whitespace category', { category: '   ' }],
      ['validFrom without an offset', { validFrom: '2026-03-01' }],
      ['empty reason', { reason: '' }],
      ['201-character reason', { reason: 'r'.repeat(201) }],
      ['shopId that is not a UUID', { shopId: 'abc' }],
      ['an unknown field', { surprise: true }],
    ])('S16 AS-09: %s is 400 validation_failed and writes nothing', async (_name, patch) => {
      const before = await total();
      const res = await post(electronicsBody(patch));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(await total()).toBe(before);
    });

    it('S16 AS-09: validTo not after validFrom is 422 rate_range_invalid', async () => {
      const before = await total();
      const res = await post(electronicsBody({ validTo: '2026-03-01T00:00:00Z' }));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('rate_range_invalid');
      expect(await total()).toBe(before);
    });

    it('S16 AS-09: a shop that does not exist is 404 shop_not_found', async () => {
      const before = await total();
      const res = await post(electronicsBody({ shopId: uuidv4() }));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('shop_not_found');
      expect(await total()).toBe(before);
    });
  });

  it('S16 AS-10: the default rate for all categories never develops a hole', async () => {
    const before = await rows();
    const res = await post({
      category: '*',
      rateBps: 900,
      validFrom: '2026-01-01T00:00:00Z',
      validTo: '2026-06-01T00:00:00Z',
      reason: 'temporary',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('default_rate_gap');
    expect(await rows()).toEqual(before);

    // a shop-level rate may leave gaps: lookups fall back to the default
    const shop = await post(electronicsBody({ category: '*', validTo: '2026-06-01T00:00:00Z' }));
    expect(shop.status).toBe(201);
  });

  describe('S16 AS-11 who may write', () => {
    it('S16 AS-11: no credentials is 401 on every admin route', async () => {
      const before = await total();
      expect((await post(electronicsBody(), { who: null })).status).toBe(401);
      expect((await get('/admin/commission-rates', null)).status).toBe(401);
      expect(
        (await get('/admin/commission-rates/as-of?category=x&validAt=2026-01-01T00:00:00Z', null)).status,
      ).toBe(401);
      expect(await total()).toBe(before);
    });

    it('S16 AS-11: a shop owner is 403 permission_denied and nothing changes', async () => {
      const before = await total();
      const res = await post(electronicsBody(), { who: owner });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('permission_denied');
      expect((await get('/admin/commission-rates', owner)).status).toBe(403);
      expect(
        (await get('/admin/commission-rates/as-of?category=x&validAt=2026-01-01T00:00:00Z', owner)).status,
      ).toBe(403);
      expect(await total()).toBe(before);
    });
  });

  describe('S16 AS-12 idempotency', () => {
    it('S16 AS-12: a replay returns the stored answer and keeps one change', async () => {
      const key = uuidv4();
      const first = await post(electronicsBody(), { key });
      const before = await total();
      const again = await post(electronicsBody(), { key });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await total()).toBe(before);
    });

    it('S16 AS-12: the same key while the first request still runs is 409 idempotency_in_flight', async () => {
      const key = uuidv4();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      // The writers of (shop, electronics) are serialised by this advisory lock: holding it keeps the first request running.
      const holder = t.sequelize.transaction(async (tx) => {
        await t.sequelize.query(
          `SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))`,
          { replacements: { k: `statements:rate:${shopA}:electronics` }, transaction: tx },
        );
        locked();
        await held;
      });
      await lockTaken;
      const first = post(electronicsBody(), { key }).then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const second = await post(electronicsBody(), { key });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('idempotency_in_flight');
      release();
      await holder;
      expect((await first).status).toBe(201);
    });

    it('S16 AS-12: the same key with another body is 422 idempotency_key_reuse', async () => {
      const key = uuidv4();
      expect((await post(electronicsBody(), { key })).status).toBe(201);
      const before = await total();
      const res = await post(electronicsBody({ rateBps: 500 }), { key });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_key_reuse');
      expect(await total()).toBe(before);
    });

    it('S16 AS-12: a missing key is 422 idempotency_key_required', async () => {
      const before = await total();
      const res = await post(electronicsBody(), { key: null });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_key_required');
      expect(await total()).toBe(before);
    });
  });

  it('S16 AS-13: 45 beliefs page as 20, 20, 5 newest first, and bad cursors and future knownAt are refused', async () => {
    // 30 writes a minute per user (statements.admin.write): three admins write the 45 changes.
    const writers = [admin, await t.admin(), await t.admin()];
    for (let i = 0; i < 45; i++) {
      const res = await post(electronicsBody({ rateBps: 100 + i }), {
        who: writers[i % 3],
      });
      expect(res.status).toBe(201);
    }
    const base = `/admin/commission-rates?shopId=${shopA}&category=electronics&limit=20`;
    const seen: { id: string; recordedFrom: string | null }[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    for (let page = 0; page < 3; page++) {
      const res = await get(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base);
      expect(res.status).toBe(200);
      const body = commissionRateHistoryPageSchema.parse(res.body);
      sizes.push(body.items.length);
      seen.push(...body.items);
      cursor = body.nextCursor;
    }
    expect(sizes).toEqual([20, 20, 5]);
    expect(cursor).toBeNull();
    expect(new Set(seen.map((i) => i.id)).size).toBe(45);
    for (let i = 1; i < seen.length; i++)
      expect(Date.parse(seen[i - 1].recordedFrom!) >= Date.parse(seen[i].recordedFrom!)).toBe(true);

    const tooMany = await get(`/admin/commission-rates?shopId=${shopA}&limit=101`);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('validation_failed');
    const tampered = await get(`${base}&cursor=${encodeURIComponent(`${cursor ?? 'x'}abc.def`)}`);
    expect(tampered.status).toBe(400);
    expect(tampered.body.code).toBe('invalid_cursor');

    const future = await get(
      '/admin/commission-rates/as-of?category=electronics&validAt=2026-05-01T00:00:00Z&knownAt=2030-01-01T00:00:00Z',
    );
    expect(future.status).toBe(422);
    expect(future.body.code).toBe('known_at_in_future');
  });

  it('S16 AS-26: reading rates writes no row, job or event', async () => {
    expect((await post(electronicsBody())).status).toBe(201);
    const count = async () => {
      const [r] = await t.sql<{ n: string }>(
        `SELECT ((SELECT count(*) FROM "CommissionRate") + (SELECT count(*) FROM "Job") + (SELECT count(*) FROM "Outbox"))::text AS n`,
      );
      return r.n;
    };
    const before = await count();
    expect((await get(`/admin/commission-rates?shopId=${shopA}`)).status).toBe(200);
    expect(
      (await get('/admin/commission-rates/as-of?category=electronics&validAt=2026-03-02T00:00:00Z')).status,
    ).toBe(200);
    expect(await count()).toBe(before);
  });
});
