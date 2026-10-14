import {
  flagAuditPageSchema,
  flagChangedEventSchema,
  problemDetailsSchema,
  staleFlagsSchema,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import { RedisRulesetPublisher } from './infra/redis-ruleset.publisher';
import { evalCountKey } from './infra/redis-keys';
import {
  createFlagsApp,
  flagBody,
  rolloutRules,
  type FlagsTestApp,
} from './testing/flags.fixtures';

const DAY = 86_400_000;

describe('Flag audit and stale report (S38)', () => {
  let t: FlagsTestApp;
  let admin: TestUser;

  beforeAll(async () => {
    t = await createFlagsApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await t.admin();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const problem = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body);
  const history = (key: string, query = '', as: TestUser = admin) =>
    t.as(as).get(`/api/admin/flags/${key}/history${query}`);

  describe('audit trail', () => {
    it('S38 AS-43: history lists [kill, update, create] newest first with actors, request ids, before and after', async () => {
      const key = t.key('audited');
      const other = await t.admin();
      await t.create(admin, key, { enabled: true });
      await t
        .put(
          other,
          key,
          flagBody({ enabled: true, owner: 'changed', expectedVersion: 1 }),
        )
        .expect(200);
      await t.post(admin, `/api/admin/flags/${key}/kill`).expect(204);

      const res = await history(key).expect(200);

      const page = flagAuditPageSchema.parse(res.body);
      expect(page.items.map((i) => i.action)).toEqual([
        'kill',
        'update',
        'create',
      ]);
      expect(page.items.map((i) => i.actorId)).toEqual([
        admin.id,
        other.id,
        admin.id,
      ]);
      expect(new Set(page.items.map((i) => i.requestId)).size).toBe(3);
      for (const item of page.items)
        expect(item.requestId).toEqual(expect.any(String));
      const [kill, update, create] = page.items as Array<{
        before: Record<string, any> | null;
        after: Record<string, any>;
      }>;
      expect(create.before).toBeNull();
      expect(create.after).toMatchObject({
        key,
        version: 1,
        status: 'enabled',
      });
      expect(update.before).toMatchObject({
        version: 1,
        owner: 'checkout-team',
      });
      expect(update.after).toMatchObject({ version: 2, owner: 'changed' });
      expect(kill.before).toMatchObject({ status: 'enabled' });
      expect(kill.after).toMatchObject({ status: 'killed', version: 3 });
      expect(page.nextCursor).toBeNull();
    });

    it('S38 AS-44: 120 rows with the same timestamp page as 50/50/20 without repeats; limits and cursors are validated', async () => {
      const key = t.key('busy');
      await t.create(admin, key, { enabled: true });
      await t.sequelize.query(`DELETE FROM "FlagAudit" WHERE "flagKey" = $1`, {
        bind: [key],
      });
      await t.sequelize.query(
        `INSERT INTO "FlagAudit" ("flagKey","actorId","action","before","after","requestId","at")
         SELECT $1, $2, 'update', NULL, jsonb_build_object('n', i), 'req-' || i, '2026-01-01T00:00:00.000000Z'::timestamptz
         FROM generate_series(1, 120) i`,
        { bind: [key, admin.id] },
      );

      const first = (await history(key).expect(200)).body;
      const second = (
        await history(
          key,
          `?cursor=${encodeURIComponent(first.nextCursor)}`,
        ).expect(200)
      ).body;
      const third = (
        await history(
          key,
          `?cursor=${encodeURIComponent(second.nextCursor)}`,
        ).expect(200)
      ).body;

      expect([
        first.items.length,
        second.items.length,
        third.items.length,
      ]).toEqual([50, 50, 20]);
      expect(third.nextCursor).toBeNull();
      const ids = [...first.items, ...second.items, ...third.items].map(
        (i: { id: string }) => BigInt(i.id),
      );
      expect(new Set(ids.map(String)).size).toBe(120);
      expect(ids).toEqual([...ids].sort((a, b) => (a > b ? -1 : 1)));

      for (const bad of ['limit=0', 'limit=201', 'limit=abc']) {
        const res = await history(key, `?${bad}`);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
      }
      const forged = await history(key, '?cursor=not-a-cursor');
      expect(forged.status).toBe(400);
      expect(problem(forged).code).toBe('invalid_cursor');
      const otherKey = t.key('other');
      await t.create(admin, otherKey, { enabled: true });
      const foreign = await history(
        otherKey,
        `?cursor=${encodeURIComponent(first.nextCursor)}`,
      );
      expect(foreign.status).toBe(400);
      expect(problem(foreign).code).toBe('invalid_cursor');
      expect(
        (await history(key, '?limit=200').expect(200)).body.items,
      ).toHaveLength(120);
    });

    it('S38 AS-45: a failing audit write rolls the whole change back: no row change, no outbox row, no push, a generic 500', async () => {
      const key = t.key('atomic');
      await t.create(admin, key, { enabled: true });
      const before = await t.flagRow(key);
      const version = await t.rulesetVersion();
      const events = (await t.outboxRows(key)).length;
      const publish = jest.spyOn(t.app.get(RedisRulesetPublisher), 'publish');
      jest
        .spyOn(t.repository, 'appendAudit')
        .mockRejectedValue(new Error('audit store exploded: secret-detail'));

      const update = await t.put(
        admin,
        key,
        flagBody({ enabled: true, owner: 'changed', expectedVersion: 1 }),
      );
      const create = await t.put(admin, t.key('never'), flagBody());
      const kill = await t.post(admin, `/api/admin/flags/${key}/kill`);

      for (const res of [update, create, kill]) {
        expect(res.status).toBe(500);
        expect(problem(res).code).toBe('internal_error');
        expect(JSON.stringify(res.body)).not.toContain('secret-detail');
      }
      expect(await t.flagRow(key)).toEqual(before);
      expect(await t.flagRows()).toHaveLength(1);
      expect(await t.rulesetVersion()).toBe(version);
      expect(await t.outboxRows(key)).toHaveLength(events);
      expect(await t.auditRows(key)).toHaveLength(1);
      expect(publish).not.toHaveBeenCalled();
    });

    it('S38 AS-46: the history is read-only (write verbs are refused), survives archiving, and an unknown key is 404', async () => {
      const key = t.key('append-only');
      await t.create(admin, key, { enabled: false });
      const rows = await t.auditRows(key);

      for (const verb of ['put', 'post', 'patch', 'delete'] as const) {
        const res = await (t.as(admin) as any)
          [verb](`/api/admin/flags/${key}/history`)
          .send({});
        expect(res.status).toBe(405);
        expect(problem(res).code).toBe('method_not_allowed');
      }
      const del = await t.as(admin).delete(`/api/admin/flags/${key}`);
      expect(del.status).toBe(405);
      expect(await t.auditRows(key)).toEqual(rows);

      await t.post(admin, `/api/admin/flags/${key}/archive`).expect(204);
      const afterArchive = flagAuditPageSchema.parse(
        (await history(key).expect(200)).body,
      );
      expect(afterArchive.items.map((i) => i.action)).toEqual([
        'archive',
        'create',
      ]);

      const unknown = await history('ghost-flag');
      expect(unknown.status).toBe(404);
      expect(problem(unknown).code).toBe('flag_not_found');
    });

    it('S38 AS-47: every applied change commits one flag_changed event and a no-op commits none', async () => {
      const key = t.key('evented');
      const same = flagBody({
        enabled: true,
        rules: rolloutRules(10),
        expectedVersion: 1,
      });
      await t.create(admin, key, { enabled: true });
      await t.put(admin, key, same).expect(200);
      await t.put(admin, key, same).expect(200); // replay: no-op
      await t.post(admin, `/api/admin/flags/${key}/kill`).expect(204);
      await t.post(admin, `/api/admin/flags/${key}/kill`).expect(204); // no-op
      await t.post(admin, `/api/admin/flags/${key}/restore`).expect(204);
      await t.post(admin, `/api/admin/flags/${key}/archive`).expect(204);

      const rows = await t.outboxRows(key);
      const events = rows.map((r) =>
        flagChangedEventSchema.parse(
          typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        ),
      );

      expect(events.map((e) => e.payload.action)).toEqual([
        'create',
        'update',
        'kill',
        'restore',
        'archive',
      ]);
      expect(events.map((e) => e.payload.flagVersion)).toEqual([1, 2, 3, 4, 5]);
      expect(events.map((e) => e.aggregateId)).toEqual(Array(5).fill(key));
      for (const e of events) {
        expect(e.payload.actorId).toBe(admin.id);
        expect(JSON.stringify(e)).not.toContain('rollout');
      }
    });
  });

  describe('stale report', () => {
    const seed = async (
      key: string,
      over: {
        ageDays: number;
        status?: string;
        expiresInDays?: number;
        evaluatedDaysAgo?: number;
      },
    ) => {
      await t.create(admin, key, { enabled: false });
      await t.backdate(
        key,
        new Date(t.clock.now().getTime() - over.ageDays * DAY),
      );
      if (over.status)
        await t.sequelize.query(
          `UPDATE "FeatureFlag" SET "status" = $2 WHERE "key" = $1`,
          { bind: [key, over.status] },
        );
      if (over.expiresInDays !== undefined)
        await t.sequelize.query(
          `UPDATE "FeatureFlag" SET "expiresAt" = $2 WHERE "key" = $1`,
          {
            bind: [
              key,
              new Date(t.clock.now().getTime() + over.expiresInDays * DAY),
            ],
          },
        );
      if (over.evaluatedDaysAgo !== undefined)
        await t.redis.hset(
          evalCountKey(
            new Date(t.clock.now().getTime() - over.evaluatedDaysAgo * DAY)
              .toISOString()
              .slice(0, 10),
          ),
          key,
          42,
        );
    };
    const stale = (query = '') =>
      t.as(admin).get(`/api/admin/flags/stale${query}`);

    it('S38 AS-48: of five flags only the expired one and the old unevaluated one are listed', async () => {
      const a = 'stale-a-old-unused';
      const b = 'stale-b-expired';
      await seed(a, { ageDays: 20 });
      await seed(b, { ageDays: 3, expiresInDays: -1, evaluatedDaysAgo: 0 });
      await seed('stale-c-evaluated', { ageDays: 20, evaluatedDaysAgo: 3 });
      await seed('stale-d-young', { ageDays: 2 });
      await seed('stale-e-archived', { ageDays: 20, status: 'archived' });

      const res = await stale().expect(200);

      const report = staleFlagsSchema.parse(res.body);
      expect(report.days).toBe(14);
      expect(report.items).toEqual([
        expect.objectContaining({
          key: a,
          reason: 'unused',
          evaluations: 0,
          expired: false,
          owner: 'checkout-team',
          status: 'disabled',
        }),
        expect.objectContaining({
          key: b,
          reason: 'expired',
          evaluations: 42,
          expired: true,
        }),
      ]);
    });

    it('S38 AS-49: days must be 1 to 30 (14 by default)', async () => {
      await seed('stale-ten-days', { ageDays: 10 });
      const keys = async (query: string) =>
        (await stale(query).expect(200)).body.items.map(
          (i: { key: string }) => i.key,
        );

      for (const bad of ['0', '31', 'abc', '-1', '1.5']) {
        const res = await stale(`?days=${bad}`);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
      }
      expect(await keys('')).toEqual([]);
      expect(await keys('?days=5')).toEqual(['stale-ten-days']);
      const thirty = await stale('?days=30').expect(200);
      expect(thirty.body.days).toBe(30);
      expect(await keys('?days=30')).toEqual([]);
    });
  });
});
