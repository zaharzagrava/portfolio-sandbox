import {
  linkStatsSchema,
  problemDetailsSchema,
  shortLinkPageSchema,
  shortLinkSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { inParallel } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  FRONT,
  createShareLinksApp,
  type ShareLinksTestApp,
} from './testing/share-links.fixtures';

describe('Share links: management and statistics', () => {
  let t: ShareLinksTestApp;
  let u1: TestUser;

  beforeAll(async () => {
    t = await createShareLinksApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    u1 = await t.user();
  });

  const problem = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body);
  const list = (user: TestUser, query = '') =>
    t.as(user).get(`/api/links${query}`);
  const page = async (user: TestUser, query = '') => {
    const res = await list(user, query);
    expect(res.status).toBe(200);
    return shortLinkPageSchema.parse(res.body);
  };
  const patch = (user: TestUser, code: string, body: object) =>
    t.as(user).patch(`/api/links/${code}`).send(body);
  const disable = (user: TestUser, code: string) =>
    t.as(user).post(`/api/links/${code}/disable`);
  const stats = (user: TestUser, code: string, query = '') =>
    t.as(user).get(`/api/links/${code}/stats${query}`);

  describe('S37 AS-48 / AS-49: the list', () => {
    it('S37 AS-48: pages newest first, shows only the caller’s links and does not repeat or skip when a link is added between pages', async () => {
      const u2 = await t.user();
      const codes: string[] = [];
      for (let i = 0; i < 5; i++) {
        codes.push(await t.newLink(u1));
        t.clock.advance(1_000);
      }
      await t.newLink(u2);

      const first = await page(u1, '?limit=2');
      expect(first.items.map((l) => l.code)).toEqual([codes[4], codes[3]]);
      expect(first.nextCursor).toBeTruthy();

      const added = await t.newLink(u1);
      const second = await page(
        u1,
        `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
      );
      expect(second.items.map((l) => l.code)).toEqual([codes[2], codes[1]]);
      const third = await page(
        u1,
        `?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`,
      );
      expect(third.items.map((l) => l.code)).toEqual([codes[0]]);
      expect(third.nextCursor).toBeNull();
      expect(
        [...first.items, ...second.items, ...third.items].map((l) => l.code),
      ).not.toContain(added);
      expect((await page(u1)).items[0].code).toBe(added);
      expect((await page(u2)).items).toHaveLength(1);
    });

    it('S37 AS-49: default 20, bounds 1–100, tampered or foreign cursors and an empty list', async () => {
      const u2 = await t.user();
      expect(await page(u2)).toEqual({ items: [], nextCursor: null });

      // 21 links in the store (create is limited to 20 a minute)
      for (let i = 0; i < 21; i++) {
        await t.plant({
          code: t.alias('listed'),
          ownerId: u1.id,
          kind: 'custom',
        });
        t.clock.advance(1_000);
      }
      const first = await page(u1);
      expect(first.items).toHaveLength(20);
      expect(first.nextCursor).toBeTruthy();
      expect((await page(u1, '?limit=100')).items).toHaveLength(21);
      expect((await page(u1, '?limit=1')).items).toHaveLength(1);

      for (const bad of ['0', '101', 'abc', '-1', '1.5']) {
        const res = await list(u1, `?limit=${bad}`);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
      }
      const cursor = first.nextCursor!;
      const tampered = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`;
      for (const bad of [tampered, 'garbage', `${cursor}.x`]) {
        const res = await list(u1, `?cursor=${encodeURIComponent(bad)}`);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('invalid_cursor');
      }
      const foreign = await list(u2, `?cursor=${encodeURIComponent(cursor)}`);
      expect(foreign.status).toBe(400);
      expect(problem(foreign).code).toBe('invalid_cursor');
    });
  });

  describe('S37 AS-50 / AS-51 / AS-55: changing the destination', () => {
    it('S37 AS-50: answers 200 with only the destination and updatedAt changed, and the next redirect follows the new one', async () => {
      const code = await t.newLink(u1);
      const before = (await t.stored(code))!;
      t.clock.advance(60_000);
      const destination = t.destination('/p/new-target');

      const res = await patch(u1, code, { destination });

      expect(res.status).toBe(200);
      const link = shortLinkSchema.parse(res.body);
      expect(link).toMatchObject({
        code,
        destination,
        status: 'ACTIVE',
        kind: before.kind,
        createdAt: before.createdAt,
        expiresAt: null,
        updatedAt: t.clock.now().toISOString(),
      });
      expect(link.updatedAt).not.toBe(before.createdAt);
      expect((await t.follow(code)).headers.location).toBe(
        `${destination}?ref=${code}`,
      );
    });

    it('S37 AS-51: an empty body, immutable or unknown fields are 400; a policy or reputation failure is 422; nothing changes', async () => {
      const destination = t.destination('/p/keep');
      const code = await t.newLink(u1, { destination });
      for (const body of [
        {},
        { code: 'other' },
        { ownerId: 'x' },
        { status: 'DISABLED' },
        { destination, alias: 'abcd' },
        { destination: '' },
      ]) {
        const res = await patch(u1, code, body);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
      }
      const off = await patch(u1, code, {
        destination: 'https://evil.example/x',
      });
      expect(off.status).toBe(422);
      expect(problem(off).code).toBe('destination_not_allowed');
      t.reputation.verdict = 'block';
      const blocked = await patch(u1, code, {
        destination: t.destination('/p/blocked'),
      });
      expect(blocked.status).toBe(422);
      expect(problem(blocked).code).toBe('destination_blocked');
      expect(await t.stored(code)).toMatchObject({ destination });
    });

    it('S37 AS-55: a warm cache never outlives a change: the next request shows the new Location, and a disable shows 410', async () => {
      const code = await t.newLink(u1);
      expect((await t.follow(code)).status).toBe(302); // warm the cache
      const destination = t.destination('/p/after-change');
      await patch(u1, code, { destination }).expect(200);
      expect((await t.follow(code)).headers.location).toBe(
        `${destination}?ref=${code}`,
      );

      await disable(u1, code).expect(200);
      expect((await t.follow(code)).status).toBe(410);
    });
  });

  describe('S37 AS-52 – AS-54: disabling', () => {
    it('S37 AS-52: disable is final, the link stays listed and its statistics stay readable, and a place is freed', async () => {
      t.config.set('share_link_max_per_owner', 2);
      const code = await t.newLink(u1);
      await t.newLink(u1);
      t.clock.advance(1_000);

      const res = await disable(u1, code);

      expect(res.status).toBe(200);
      expect(shortLinkSchema.parse(res.body)).toMatchObject({
        status: 'DISABLED',
        disabledAt: t.clock.now().toISOString(),
      });
      expect((await t.follow(code)).status).toBe(410);
      expect((await page(u1)).items.find((l) => l.code === code)?.status).toBe(
        'DISABLED',
      );
      expect((await stats(u1, code)).status).toBe(200);
      expect(
        (await t.create(u1, { destination: t.destination() })).status,
      ).toBe(201);
    });

    it('S37 AS-53: disabling or changing a disabled or expired link is 409 link_not_active and changes nothing', async () => {
      const disabled = await t.newLink(u1);
      await disable(u1, disabled).expect(200);
      const lapsed = t.alias('lapsed');
      await t.plant({
        code: lapsed,
        ownerId: u1.id,
        expiresAt: new Date(t.clock.now().getTime() - 1).toISOString(),
      });
      const before = await t.raw(disabled);

      for (const code of [disabled, lapsed]) {
        for (const res of [
          await disable(u1, code),
          await patch(u1, code, { destination: t.destination('/p/late') }),
        ]) {
          expect(res.status).toBe(409);
          expect(problem(res).code).toBe('link_not_active');
        }
      }
      expect(await t.raw(disabled)).toEqual(before);
    });

    it('S37 AS-54: a change racing a disable, two disables and two changes end in the specified states', async () => {
      const raced = await t.newLink(u1);
      const [changed, disabled] = (
        await inParallel(2, (i) =>
          i === 0
            ? patch(u1, raced, { destination: t.destination('/p/raced') })
            : disable(u1, raced),
        )
      ).map(
        (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
      );
      expect(disabled).toBe(200);
      expect([200, 409]).toContain(changed);
      expect(await t.stored(raced)).toMatchObject({ status: 'DISABLED' });

      const twice = await t.newLink(u1);
      const bothDisable = (await inParallel(2, () => disable(u1, twice))).map(
        (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
      );
      expect(bothDisable.sort()).toEqual([200, 409]);

      const target = await t.newLink(u1);
      const dest = [t.destination('/p/one'), t.destination('/p/two')];
      const bothChange = await inParallel(2, (i) =>
        patch(u1, target, { destination: dest[i] }),
      );
      expect(
        bothChange.map(
          (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
        ),
      ).toEqual([200, 200]);
      expect(dest).toContain((await t.stored(target))!.destination);
    });
  });

  it('S37 AS-56: another user’s change, disable and statistics are the same 404 as an unknown code, and nothing changes', async () => {
    const u2 = await t.user();
    const destination = t.destination('/p/mine');
    const code = await t.newLink(u1, { destination });
    const unknown = await patch(u2, 'Zz9Zz9Z', { destination });
    expect(unknown.status).toBe(404);

    for (const target of [code, 'Zz9Zz9Z', 'a$b', 'abc']) {
      const responses = [
        await patch(u2, target, { destination: t.destination('/p/stolen') }),
        await disable(u2, target),
        await stats(u2, target),
      ];
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(problem(res).code).toBe('link_not_found');
        expect(res.body.detail).toBe(unknown.body.detail);
      }
    }
    expect(await t.stored(code)).toMatchObject({
      destination,
      status: 'ACTIVE',
      ownerId: u1.id,
    });
  });

  describe('S37 AS-57 – AS-61: statistics', () => {
    const clickAt = (code: string, at: Date | string, country = 'DE') =>
      t.clickEvent(code, {
        payload: {
          ts: typeof at === 'string' ? at : at.toISOString(),
          country,
        },
      });
    const project = (events: ReturnType<typeof clickAt>[]) =>
      t.projector.project(events as never);
    const minutesAgo = (n: number) =>
      new Date(t.clock.now().getTime() - n * 60_000);

    it('S37 AS-57: known clicks give the contract body with numeric counts, ascending buckets and top countries', async () => {
      const code = await t.newLink(u1);
      await project([
        clickAt(code, minutesAgo(30), 'DE'),
        clickAt(code, minutesAgo(30), 'DE'),
        clickAt(code, minutesAgo(10), 'DE'),
        clickAt(code, minutesAgo(10), 'FR'),
        clickAt(code, minutesAgo(5), 'FR'),
      ]);

      const res = await stats(u1, code, '?range=24h');

      expect(res.status).toBe(200);
      const body = linkStatsSchema.parse(res.body);
      expect(body).toMatchObject({
        code,
        range: '24h',
        bucket: 'minute',
        total: 5,
      });
      expect(body.series.map((s) => s.clicks)).toEqual([2, 2, 1]);
      expect(body.series.map((s) => s.start)).toEqual(
        [...body.series.map((s) => s.start)].sort(),
      );
      expect(body.countries).toEqual([
        { country: 'DE', clicks: 3 },
        { country: 'FR', clicks: 2 },
      ]);
      expect(typeof res.body.total).toBe('number');
    });

    it('S37 AS-58: ranges choose minute, hour and day buckets; the window is [T − range, T]; bad ranges are 400', async () => {
      const code = await t.newLink(u1);
      const now = t.clock.now();
      const from = new Date(now.getTime() - 24 * 3_600_000);
      await project([
        clickAt(code, from), // exactly at `from`: included
        clickAt(code, new Date(from.getTime() - 1)), // just before: not in 24h
        clickAt(code, now), // exactly at `to`: included
        clickAt(code, new Date(now.getTime() + 1)), // just after `to`: not counted
        clickAt(code, new Date(now.getTime() - 3 * 86_400_000)), // inside 7d, outside 24h
      ]);

      const day = linkStatsSchema.parse(
        (await stats(u1, code, '?range=24h')).body,
      );
      expect(day).toMatchObject({
        bucket: 'minute',
        total: 2,
        from: from.toISOString(),
        to: now.toISOString(),
      });
      const week = linkStatsSchema.parse((await stats(u1, code)).body); // default 7d
      expect(week).toMatchObject({ range: '7d', bucket: 'hour' });
      expect(week.total).toBe(4);
      const month = linkStatsSchema.parse(
        (await stats(u1, code, '?range=30d')).body,
      );
      expect(month).toMatchObject({ bucket: 'day', total: 4 });
      expect(
        month.series.every((s) => s.start.endsWith('T00:00:00.000Z')),
      ).toBe(true);

      for (const bad of ['?range=1h', '?range=1y', '?range=']) {
        const res = await stats(u1, code, bad);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
      }
    });

    it('S37 AS-59: a link without clicks has zeros and empty lists; expired and disabled links stay readable', async () => {
      const quiet = await t.newLink(u1);
      expect(
        linkStatsSchema.parse((await stats(u1, quiet)).body),
      ).toMatchObject({ total: 0, series: [], countries: [] });

      const gone = await t.newLink(u1);
      await project([clickAt(gone, minutesAgo(5))]);
      await disable(u1, gone).expect(200);
      expect(linkStatsSchema.parse((await stats(u1, gone)).body).total).toBe(1);
      const lapsed = t.alias('lapsed');
      await t.plant({
        code: lapsed,
        ownerId: u1.id,
        expiresAt: new Date(t.clock.now().getTime() - 1).toISOString(),
      });
      expect((await stats(u1, lapsed)).status).toBe(200);
    });

    it('S37 AS-60: a click is visible as soon as the consumer has processed it, and the lag gauge exists', async () => {
      const code = await t.newLink(u1);
      expect(linkStatsSchema.parse((await stats(u1, code)).body).total).toBe(0);
      await project([clickAt(code, minutesAgo(1))]);
      expect(linkStatsSchema.parse((await stats(u1, code)).body).total).toBe(1);
      expect(MetricsRegistry.value('link_click_consumer_lag')).toBeDefined();
    });

    it('S37 AS-61: with the analytics store down, statistics are 503 while create, list, change, disable and redirect work', async () => {
      const code = await t.newLink(u1);
      const other = await t.newLink(u1);
      t.faults.set('stats', { kind: 'down' });

      const res = await stats(u1, code);
      expect(res.status).toBe(503);
      expect(problem(res).code).toBe('service_unavailable');

      expect(
        (await t.create(u1, { destination: t.destination() })).status,
      ).toBe(201);
      expect((await list(u1)).status).toBe(200);
      expect(
        (await patch(u1, code, { destination: `${FRONT}/p/still-works` }))
          .status,
      ).toBe(200);
      expect((await disable(u1, other)).status).toBe(200);
      expect((await t.follow(code)).status).toBe(302);
    });
  });
});
