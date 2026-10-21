import { QueryTypes } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import {
  experimentHistoryPageSchema,
  experimentPageSchema,
  experimentSchema,
} from '@marketplace-sandbox/contracts';
import { Role } from '@app/domains/identity';
import type { TestUser } from '@app/test/utils/catalog-app';
import { RUNNING_SET_CACHE, type RunningSetCache } from './domain/ports';
import {
  T0,
  createAnalyticsApp,
  seedExperiment,
  truncateExperiments,
  type AnalyticsTestApp,
} from './testing/analytics.fixtures';

let counter = 0;
/** A body of its own: a fresh layer, so no spec's experiment collides with another's range. */
const body = (patch: Record<string, unknown> = {}) => ({
  expectedVersion: 0,
  description: 'gallery layout test',
  owner: 'growth',
  unit: 'visitor',
  variants: [
    { key: 'control', weight: 5_000 },
    { key: 'gallery', weight: 5_000 },
  ],
  layer: `lyr-${++counter}-${uuidv4().slice(0, 8)}`,
  layerFrom: 0,
  layerTo: 5_000,
  metric: 'add_to_cart',
  ...patch,
});

const strip = (problem: Record<string, any>) => {
  const { instance, requestId, ...rest } = problem;
  return rest;
};

describe('Experiments admin API (S39)', () => {
  let t: AnalyticsTestApp;
  let admin: TestUser;
  let other: TestUser;

  const put = (user: TestUser, key: string, payload: unknown) =>
    t
      .as(user)
      .put(`/api/admin/experiments/${key}`)
      .send(payload as object);
  const post = (user: TestUser, key: string, action: 'start' | 'stop') =>
    t.as(user).post(`/api/admin/experiments/${key}/${action}`);
  const get = (user: TestUser, path = '') =>
    t.as(user).get(`/api/admin/experiments${path}`);
  const key = (prefix = 'exp') =>
    `${prefix}-${++counter}-${uuidv4().slice(0, 8)}`;
  const create = async (name = key(), patch: Record<string, unknown> = {}) => {
    const res = await put(admin, name, body(patch));
    if (res.status !== 201)
      throw new Error(
        `create ${name} answered ${res.status}: ${JSON.stringify(res.body)}`,
      );
    return { key: name, experiment: res.body };
  };
  const rows = (sql: string, bind: unknown[] = []) =>
    t.sequelize.query<Record<string, any>>(sql, {
      bind,
      type: QueryTypes.SELECT,
    });
  const audit = (name: string) =>
    rows(
      `SELECT * FROM "ExperimentAudit" WHERE "experimentKey" = $1 ORDER BY "at" DESC, "id" DESC`,
      [name],
    );
  const row = async (name: string) =>
    (await rows(`SELECT * FROM "Experiment" WHERE "key" = $1`, [name]))[0];
  const count = async () =>
    Number((await rows('SELECT count(*) AS n FROM "Experiment"'))[0].n);
  /** Distinct write times, so "newest first" has an answer under a frozen clock. */
  const tick = () => t.clock.advance(1_000);

  beforeAll(async () => {
    t = await createAnalyticsApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(T0);
    await truncateExperiments(t.sequelize);
    await t.app.get<RunningSetCache>(RUNNING_SET_CACHE).invalidate();
    admin = await t.admin();
    other = await t.admin();
  });

  describe('create and update', () => {
    it('S39 AS-30: a draft is created with 201, Location, the stored experiment and one create history row', async () => {
      const name = key('pdp-layout');
      const payload = body({ layer: 'pdp', layerFrom: 0, layerTo: 5_000 });
      const res = await put(admin, name, payload);
      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/api/admin/experiments/${name}`);
      const experiment = experimentSchema.parse(res.body);
      expect(experiment).toMatchObject({
        key: name,
        status: 'draft',
        version: 1,
        unit: 'visitor',
        owner: 'growth',
        metric: 'add_to_cart',
        layer: 'pdp',
        layerFrom: 0,
        layerTo: 5_000,
        variants: payload.variants,
        startedAt: null,
        stoppedAt: null,
        startedBy: null,
        stoppedBy: null,
        createdAt: T0.toISOString(),
        updatedAt: T0.toISOString(),
      });
      const history = await audit(name);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        action: 'create',
        actorId: admin.id,
        before: null,
      });
      expect(history[0].after).toMatchObject({
        key: name,
        status: 'draft',
        version: 1,
      });
      expect((await row(name)).status).toBe('DRAFT');
    });

    it('S39 AS-30: creating the same experiment again with the same body is a 200 no-op, not a second 201', async () => {
      const name = key();
      const payload = body();
      expect((await put(admin, name, payload)).status).toBe(201);
      const again = await put(admin, name, payload);
      expect(again.status).toBe(200);
      expect(again.body.version).toBe(1);
      expect(await audit(name)).toHaveLength(1);
    });

    it('S39 AS-31: an update with the current version bumps it and records before and after; a stale version is 409 version_conflict', async () => {
      const { key: name, experiment } = await create();
      tick();
      const updated = await put(admin, name, {
        ...body({ layer: experiment.layer }),
        expectedVersion: 1,
        description: 'a new description',
        variants: [
          { key: 'control', weight: 4_000 },
          { key: 'gallery', weight: 6_000 },
        ],
      });
      expect(updated.status).toBe(200);
      expect(experimentSchema.parse(updated.body)).toMatchObject({
        version: 2,
        description: 'a new description',
        updatedAt: new Date(T0.getTime() + 1_000).toISOString(),
      });
      const history = await audit(name);
      expect(history.map((h) => h.action)).toEqual(['update', 'create']);
      expect(history[0].before).toMatchObject({
        version: 1,
        description: 'gallery layout test',
      });
      expect(history[0].after).toMatchObject({
        version: 2,
        description: 'a new description',
      });

      const stale = await put(other, name, {
        ...body({ layer: experiment.layer }),
        expectedVersion: 1,
        description: 'someone else',
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('version_conflict');
      expect(stale.body.currentVersion).toBe(2);
      expect((await row(name)).description).toBe('a new description');
    });

    it('S39 AS-31: a save equal to the stored definition is 200 with no version bump and no history row', async () => {
      const { key: name, experiment } = await create();
      const same = {
        expectedVersion: 1,
        description: experiment.description,
        owner: experiment.owner,
        unit: experiment.unit,
        variants: experiment.variants,
        layer: experiment.layer,
        layerFrom: experiment.layerFrom,
        layerTo: experiment.layerTo,
        metric: experiment.metric,
      };
      tick();
      const res = await put(admin, name, same);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(experiment);
      expect(await audit(name)).toHaveLength(1);
    });

    it('S39 AS-31: two admins saving different definitions from the same version at once: exactly one wins', async () => {
      const { key: name, experiment } = await create();
      const base = body({ layer: experiment.layer });
      const [a, b] = await Promise.all([
        put(admin, name, {
          ...base,
          expectedVersion: 1,
          description: 'from A',
        }),
        put(other, name, {
          ...base,
          expectedVersion: 1,
          description: 'from B',
        }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe('version_conflict');
      const stored = await row(name);
      expect(stored.version).toBe(2);
      expect(stored.description).toBe(a.status === 200 ? 'from A' : 'from B');
      expect(await audit(name)).toHaveLength(2);
    });

    it('S39 AS-31: an update of an unknown key with expectedVersion above 0 is 404 not_found and persists nothing', async () => {
      const res = await put(admin, key(), { ...body(), expectedVersion: 2 });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
      expect(await count()).toBe(0);
    });
  });

  describe('validation', () => {
    it.each([
      ['a variants list that is not a list', { variants: 'a,b' }],
      ['a negative expectedVersion', { expectedVersion: -1 }],
      ['a missing expectedVersion', { expectedVersion: undefined }],
      ['an unknown field', { colour: 'red' }],
      ['an unknown unit', { unit: 'device' }],
      ['an owner that is not a string', { owner: 5 }],
      ['a description of 501 characters', { description: 'x'.repeat(501) }],
      ['an owner of 101 characters', { owner: 'x'.repeat(101) }],
    ])('S39 AS-32: %s is 400 validation_failed', async (_label, patch) => {
      const res = await put(admin, key(), body(patch));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(await count()).toBe(0);
    });

    it.each(['Bad_Key', 'a', 'UPPER', 'has space', 'x'.repeat(65)])(
      'S39 AS-32: the key %j in the path is 400 validation_failed',
      async (bad) => {
        const res = await put(admin, encodeURIComponent(bad), body());
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      },
    );

    it('S39 AS-32: semantic problems are 422 experiment_definition_invalid with every {path, code} at once', async () => {
      const res = await put(
        admin,
        key(),
        body({
          owner: '',
          metric: 'purchase',
          layer: 'Bad Layer',
          layerFrom: 7,
          layerTo: 7,
          variants: [
            { key: 'A', weight: 0 },
            { key: 'A', weight: 5_000 },
          ],
        }),
      );
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('experiment_definition_invalid');
      expect(res.body.errors.map((e: any) => [e.path, e.code])).toEqual([
        ['variants[0].key', 'variant_key_invalid'],
        ['variants[0].weight', 'weight_invalid'],
        ['variants[1].key', 'variant_key_invalid'],
        ['variants[1].key', 'variant_key_duplicate'],
        ['layer', 'layer_invalid'],
        ['layerTo', 'layer_range_invalid'],
        ['metric', 'metric_unit_mismatch'],
        ['owner', 'owner_required'],
      ]);
      expect(res.body.errors.every((e: any) => e.field === e.path)).toBe(true);
    });

    it('S39 AS-32: weights that do not sum to 10,000 and a variants count outside 2-10 are reported', async () => {
      const sum = await put(
        admin,
        key(),
        body({
          variants: [
            { key: 'a', weight: 5_000 },
            { key: 'b', weight: 4_000 },
          ],
        }),
      );
      expect(sum.status).toBe(422);
      expect(sum.body.errors).toEqual([
        expect.objectContaining({ path: 'variants', code: 'weights_sum' }),
      ]);
      const count = await put(
        admin,
        key(),
        body({ variants: [{ key: 'a', weight: 10_000 }] }),
      );
      expect(count.body.errors).toEqual([
        expect.objectContaining({ path: 'variants', code: 'variants_count' }),
      ]);
    });
  });

  describe('start and stop', () => {
    it('S39 AS-33: start runs a draft at the frozen time with one history row; a repeat changes nothing, in parallel or not', async () => {
      const { key: name } = await create();
      tick();
      const started = await post(admin, name, 'start');
      expect(started.status).toBe(200);
      expect(experimentSchema.parse(started.body)).toMatchObject({
        status: 'running',
        version: 2,
        startedAt: new Date(T0.getTime() + 1_000).toISOString(),
        startedBy: admin.id,
      });
      expect((await audit(name)).map((h) => h.action)).toEqual([
        'start',
        'create',
      ]);

      tick();
      const again = await post(admin, name, 'start');
      expect(again.status).toBe(200);
      expect(again.body).toEqual(started.body);
      expect(await audit(name)).toHaveLength(2);

      const second = await create();
      const both = await Promise.all([
        post(admin, second.key, 'start'),
        post(other, second.key, 'start'),
      ]);
      expect(both.map((r) => r.status)).toEqual([200, 200]);
      expect(both[0].body.version).toBe(2);
      expect(both[1].body.version).toBe(2);
      expect((await audit(second.key)).map((h) => h.action).sort()).toEqual([
        'create',
        'start',
      ]);
    });

    it('S39 AS-34: stop ends a running experiment, repeats change nothing, and a stopped experiment cannot start again', async () => {
      const { key: name } = await create();
      tick();
      await post(admin, name, 'start').expect(200);
      tick();
      const stopped = await post(admin, name, 'stop');
      expect(stopped.status).toBe(200);
      expect(experimentSchema.parse(stopped.body)).toMatchObject({
        status: 'stopped',
        version: 3,
        stoppedAt: new Date(T0.getTime() + 2_000).toISOString(),
        stoppedBy: admin.id,
      });
      expect((await audit(name)).map((h) => h.action)).toEqual([
        'stop',
        'start',
        'create',
      ]);

      tick();
      const repeat = await post(admin, name, 'stop');
      expect(repeat.status).toBe(200);
      expect(repeat.body).toEqual(stopped.body);
      expect(await audit(name)).toHaveLength(3);

      const restart = await post(admin, name, 'start');
      expect(restart.status).toBe(409);
      expect(restart.body.code).toBe('illegal_transition');
      expect((await row(name)).status).toBe('STOPPED');
    });

    it('S39 AS-34: stopping a draft is 409 illegal_transition; an unknown key is 404 for both actions', async () => {
      const { key: name } = await create();
      const res = await post(admin, name, 'stop');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('illegal_transition');
      expect(res.body.currentStatus).toBe('draft');
      for (const action of ['start', 'stop'] as const) {
        const unknown = await post(admin, key('ghost'), action);
        expect(unknown.status).toBe(404);
        expect(unknown.body.code).toBe('not_found');
      }
    });

    it('S39 AS-24: a start makes the experiment assignable at once and a stop removes it at once on the same instance', async () => {
      const { key: name } = await create(key(), {
        unit: 'visitor',
        layerTo: 10_000,
      });
      const assignments = async () =>
        (
          await t
            .http()
            .get('/api/experiments/assignments')
            .set(
              'X-Forwarded-For',
              `10.88.${++counter % 250}.${((counter >> 8) % 250) + 1}`,
            )
            .set('X-Anonymous-Id', 'anon-12345678')
        ).body.assignments;
      expect(await assignments()).toEqual({});
      await post(admin, name, 'start').expect(200);
      expect(Object.keys(await assignments())).toEqual([name]);
      await post(admin, name, 'stop').expect(200);
      expect(await assignments()).toEqual({});
    });
  });

  describe('immutability', () => {
    it.each([
      [
        'variants',
        {
          variants: [
            { key: 'control', weight: 6_000 },
            { key: 'gallery', weight: 4_000 },
          ],
        },
      ],
      [
        'variant keys',
        {
          variants: [
            { key: 'control', weight: 5_000 },
            { key: 'other', weight: 5_000 },
          ],
        },
      ],
      ['layer', { layer: 'another-layer' }],
      ['range', { layerFrom: 0, layerTo: 6_000 }],
      ['unit', { unit: 'user' }],
      ['metric', { metric: 'click' }],
    ])(
      'S39 AS-35: changing the %s of a running experiment is 409 experiment_immutable and nothing changes',
      async (_field, patch) => {
        const { key: name, experiment } = await create();
        await post(admin, name, 'start').expect(200);
        const before = await row(name);
        const res = await put(admin, name, {
          ...body({ layer: experiment.layer }),
          expectedVersion: 2,
          ...patch,
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('experiment_immutable');
        expect(await row(name)).toEqual(before);
        expect(await audit(name)).toHaveLength(2);
      },
    );

    it('S39 AS-35: a stopped experiment is immutable too', async () => {
      const { key: name, experiment } = await create();
      await post(admin, name, 'start').expect(200);
      await post(admin, name, 'stop').expect(200);
      const res = await put(admin, name, {
        ...body({ layer: experiment.layer }),
        expectedVersion: 3,
        metric: 'click',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('experiment_immutable');
    });

    it('S39 AS-35: description and owner can change while running', async () => {
      const { key: name, experiment } = await create();
      await post(admin, name, 'start').expect(200);
      tick();
      const res = await put(admin, name, {
        ...body({ layer: experiment.layer }),
        expectedVersion: 2,
        description: 'running notes',
        owner: 'platform',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        version: 3,
        description: 'running notes',
        owner: 'platform',
        status: 'running',
      });
      expect((await audit(name))[0]).toMatchObject({ action: 'update' });
    });
  });

  describe('layers', () => {
    it('S39 AS-36: starting an overlapping range is 409 layer_range_conflict naming the blocker; a disjoint range or another layer starts; stopping frees the range', async () => {
      const layer = `shared-${uuidv4().slice(0, 8)}`;
      const a = await create(key('first'), {
        layer,
        layerFrom: 0,
        layerTo: 5_000,
      });
      await post(admin, a.key, 'start').expect(200);

      const overlapping = await create(key('overlap'), {
        layer,
        layerFrom: 4_000,
        layerTo: 6_000,
      });
      const refused = await post(admin, overlapping.key, 'start');
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('layer_range_conflict');
      expect(refused.body.blockingKey).toBe(a.key);
      expect((await row(overlapping.key)).status).toBe('DRAFT');
      expect(await audit(overlapping.key)).toHaveLength(1);

      const disjoint = await create(key('disjoint'), {
        layer,
        layerFrom: 5_000,
        layerTo: 10_000,
      });
      await post(admin, disjoint.key, 'start').expect(200);
      const elsewhere = await create(key('elsewhere'), {
        layerFrom: 0,
        layerTo: 10_000,
      });
      await post(admin, elsewhere.key, 'start').expect(200);

      await post(admin, a.key, 'stop').expect(200);
      const freed = await post(admin, overlapping.key, 'start');
      expect(freed.status).toBe(409); // still blocked by the disjoint one it overlaps from 5,000 to 6,000
      expect(freed.body.blockingKey).toBe(disjoint.key);
    });

    it('S39 AS-36: after the blocker is stopped the overlapping draft can start', async () => {
      const layer = `shared-${uuidv4().slice(0, 8)}`;
      const a = await create(key('first'), {
        layer,
        layerFrom: 0,
        layerTo: 5_000,
      });
      const b = await create(key('second'), {
        layer,
        layerFrom: 4_000,
        layerTo: 6_000,
      });
      await post(admin, a.key, 'start').expect(200);
      await post(admin, b.key, 'start').expect(409);
      await post(admin, a.key, 'stop').expect(200);
      await post(admin, b.key, 'start').expect(200);
    });

    it('S39 AS-36: two overlapping drafts started at once give exactly one 200 and one 409, and the database never holds two overlapping running ranges', async () => {
      const layer = `race-${uuidv4().slice(0, 8)}`;
      const a = await create(key('race-a'), {
        layer,
        layerFrom: 0,
        layerTo: 6_000,
      });
      const b = await create(key('race-b'), {
        layer,
        layerFrom: 4_000,
        layerTo: 10_000,
      });
      const results = await Promise.all([
        post(admin, a.key, 'start'),
        post(other, b.key, 'start'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const refused = results.find((r) => r.status === 409)!;
      expect(refused.body.code).toBe('layer_range_conflict');
      const overlaps = await rows(
        `SELECT count(*) AS n FROM "Experiment" x JOIN "Experiment" y
           ON x."key" < y."key" AND x."layer" = y."layer" AND x."status" = 'RUNNING' AND y."status" = 'RUNNING'
          AND int4range(x."layerFrom", x."layerTo") && int4range(y."layerFrom", y."layerTo")
         WHERE x."layer" = $1`,
        [layer],
      );
      expect(Number(overlaps[0].n)).toBe(0);
    });
  });

  describe('limit', () => {
    it('S39 AS-37: the 201st key is 422 experiment_limit_reached; an update of an existing key still works', async () => {
      const first = await create();
      await Promise.all(
        Array.from({ length: 199 }, (_, n) =>
          seedExperiment(t.sequelize, {
            status: 'DRAFT',
            createdAt: new Date(T0.getTime() - (n + 1) * 1_000),
          }),
        ),
      );
      const refused = await put(admin, key(), body());
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('experiment_limit_reached');
      const updated = await put(admin, first.key, {
        ...body({ layer: first.experiment.layer }),
        expectedVersion: 1,
        description: 'still editable',
      });
      expect(updated.status).toBe(200);
    }, 60_000);

    it('S39 AS-37: parallel creates cannot exceed 200', async () => {
      await Promise.all(
        Array.from({ length: 198 }, () =>
          seedExperiment(t.sequelize, { status: 'DRAFT' }),
        ),
      );
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          put(i % 2 ? admin : other, key('race'), body()),
        ),
      );
      const created = results.filter((r) => r.status === 201).length;
      expect(created).toBe(2);
      expect(results.filter((r) => r.status === 422)).toHaveLength(3);
      expect(await count()).toBe(200);
    }, 60_000);
  });

  describe('reads', () => {
    it('S39 AS-38: 120 experiments are listed in pages by createdAt then key, newest first, each once', async () => {
      const keys: string[] = [];
      for (let i = 0; i < 120; i++)
        keys.push(`seed-${String(i).padStart(3, '0')}`);
      await Promise.all(
        keys.map((name, i) =>
          // Ten share each creation time, so the key decides among them.
          seedExperiment(t.sequelize, {
            key: name,
            status: i % 3 === 0 ? 'RUNNING' : 'DRAFT',
            layer: `seed-layer-${i}`,
            createdAt: new Date(T0.getTime() - Math.floor(i / 10) * 1_000),
          }),
        ),
      );
      const expectedOrder = [...keys].sort((x, y) => {
        const gx = Math.floor(keys.indexOf(x) / 10);
        const gy = Math.floor(keys.indexOf(y) / 10);
        return gx !== gy ? gx - gy : y.localeCompare(x);
      });
      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      do {
        const res = await get(
          admin,
          `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        expect(res.status).toBe(200);
        const page = experimentPageSchema.parse(res.body);
        sizes.push(page.items.length);
        seen.push(...page.items.map((e) => e.key));
        cursor = page.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([50, 50, 20]);
      expect(seen).toEqual(expectedOrder);
      expect(new Set(seen).size).toBe(120);

      const running = await get(admin, '?status=running&limit=200');
      expect(experimentPageSchema.parse(running.body).items).toHaveLength(40);
      expect(running.body.items.every((e: any) => e.status === 'running')).toBe(
        true,
      );
      expect(running.body.nextCursor).toBeNull();
      const defaults = await get(admin);
      expect(defaults.body.items).toHaveLength(50);
    }, 60_000);

    it.each(['0', '201', 'abc', '-1', '1.5'])(
      'S39 AS-38: limit=%s is 400 validation_failed',
      async (limit) => {
        const res = await get(admin, `?limit=${limit}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      },
    );

    it('S39 AS-38: a tampered or foreign cursor is 400 and an unknown status filter is 400', async () => {
      for (let i = 0; i < 3; i++)
        await seedExperiment(t.sequelize, { status: 'DRAFT' });
      const page = await get(admin, '?limit=1');
      const cursor: string = page.body.nextCursor;
      expect(cursor).toEqual(expect.any(String));
      for (const bad of [
        cursor + 'x',
        `${cursor.split('.')[0]}.AAAA`,
        'garbage',
        cursor.split('.')[0],
      ]) {
        const res = await get(admin, `?cursor=${encodeURIComponent(bad)}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_cursor');
      }
      expect((await get(admin, '?status=paused')).status).toBe(400);
    });

    it('S39 AS-38: get returns one experiment; an unknown key is 404 not_found', async () => {
      const { key: name, experiment } = await create();
      const res = await get(admin, `/${name}`);
      expect(res.status).toBe(200);
      expect(experimentSchema.parse(res.body)).toEqual(experiment);
      const missing = await get(admin, '/no-such-experiment');
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('not_found');
    });
  });

  describe('history', () => {
    it('S39 AS-39: every applied change has one row, a no-op has none, newest first, with the actor and both sides', async () => {
      const { key: name, experiment } = await create();
      tick();
      await put(other, name, {
        ...body({ layer: experiment.layer }),
        expectedVersion: 1,
        description: 'v2',
      }).expect(200);
      tick();
      await put(other, name, {
        ...body({ layer: experiment.layer }),
        expectedVersion: 2,
        description: 'v2',
      }).expect(200); // no-op
      tick();
      await post(admin, name, 'start').expect(200);
      tick();
      await post(admin, name, 'start').expect(200); // no-op
      tick();
      await post(other, name, 'stop').expect(200);
      const res = await get(admin, `/${name}/history`);
      expect(res.status).toBe(200);
      const page = experimentHistoryPageSchema.parse(res.body);
      expect(page.items.map((i) => i.action)).toEqual([
        'stop',
        'start',
        'update',
        'create',
      ]);
      expect(page.items.map((i) => i.actorId)).toEqual([
        other.id,
        admin.id,
        other.id,
        admin.id,
      ]);
      expect(page.items.every((i) => i.actorId.length > 0)).toBe(true);
      expect(page.items[0].before).toMatchObject({
        status: 'running',
        version: 3,
      });
      expect(page.items[0].after).toMatchObject({
        status: 'stopped',
        version: 4,
      });
      expect(page.items[3].before).toBeNull();
      expect(page.nextCursor).toBeNull();
    });

    it('S39 AS-39: history is paged by keyset, newest first, and 404 for an unknown key', async () => {
      const { key: name, experiment } = await create();
      for (let v = 1; v <= 4; v++) {
        tick();
        await put(admin, name, {
          ...body({ layer: experiment.layer }),
          expectedVersion: v,
          description: `v${v + 1}`,
        }).expect(200);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(
          admin,
          `/${name}/history?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        const page = experimentHistoryPageSchema.parse(res.body);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      const all = (await audit(name)).map((h) => h.id);
      expect(seen).toEqual(all);
      expect(seen).toHaveLength(5);
      expect((await get(admin, '/no-such-experiment/history')).status).toBe(
        404,
      );
      expect((await get(admin, `/${name}/history?limit=0`)).status).toBe(400);
      // A cursor of another experiment's history is refused.
      const other2 = await create();
      const foreign = (await get(admin, `/${name}/history?limit=1`)).body
        .nextCursor;
      const res = await get(
        admin,
        `/${other2.key}/history?cursor=${encodeURIComponent(foreign)}`,
      );
      expect(res.status).toBe(400);
    });

    it('S39 AS-39: history rows cannot be written or removed through the API', async () => {
      const { key: name } = await create();
      for (const method of ['put', 'post', 'patch', 'delete'] as const) {
        const res = await (t.as(admin) as any)
          [method](`/api/admin/experiments/${name}/history`)
          .send({});
        expect([404, 405]).toContain(res.status);
      }
      expect(await audit(name)).toHaveLength(1);
    });
  });

  describe('access', () => {
    const routes: [string, string, string][] = [
      ['get', '/api/admin/experiments', 'list'],
      ['get', '/api/admin/experiments/KEY', 'one'],
      ['put', '/api/admin/experiments/KEY', 'save'],
      ['post', '/api/admin/experiments/KEY/start', 'start'],
      ['post', '/api/admin/experiments/KEY/stop', 'stop'],
      ['get', '/api/admin/experiments/KEY/history', 'history'],
      ['get', '/api/admin/experiments/KEY/results', 'results'],
    ];
    const send = (agent: any, method: string, path: string, name: string) => {
      const request = agent[method](path.replace('KEY', name));
      return method === 'put'
        ? request.send(body({ expectedVersion: 1 }))
        : request;
    };

    it.each(routes)(
      'S39 AS-40: %s %s (%s) without credentials is 401',
      async (method, path) => {
        const res = await send(t.http(), method, path, 'some-experiment');
        expect(res.status).toBe(401);
      },
    );

    it.each(
      [Role.USER, Role.SELLER, Role.MODERATOR].flatMap((role) =>
        routes.map(([m, p, label]) => [role, m, p, label] as const),
      ),
    )(
      'S39 AS-40: a %s on %s %s (%s) gets the same 403 whether or not the key exists',
      async (role, method, path) => {
        const user = await t.newUser({ role });
        const { key: existing } = await create();
        const before = await row(existing);
        const known = await send(t.as(user), method, path, existing);
        const unknown = await send(
          t.as(user),
          method,
          path,
          'no-such-experiment',
        );
        expect(known.status).toBe(403);
        expect(unknown.status).toBe(403);
        expect(strip(known.body)).toEqual(strip(unknown.body));
        expect(await row(existing)).toEqual(before);
      },
    );
  });

  it('S39 AS-41: the 31st admin write in a minute is 429 with Retry-After; reads and other admins are unaffected', async () => {
    const busy = await t.admin();
    // Every request that reaches the limiter counts, whatever the controller then does with it.
    for (let i = 0; i < 30; i++) {
      const res = await put(busy, key(), {});
      expect(res.status).toBe(400);
    }
    const limited = await put(busy, key(), {});
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await post(busy, 'whatever', 'start')).status).toBe(429);
    expect((await get(busy)).status).toBe(200);
    expect((await put(other, key(), body())).status).toBe(201);
  }, 60_000);
});
