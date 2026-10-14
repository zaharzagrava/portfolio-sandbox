import {
  flagSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { Role } from '@app/domains/identity';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  createFlagsApp,
  flagBody,
  rolloutRules,
  type FlagsTestApp,
} from './testing/flags.fixtures';

const strip = (body: Record<string, unknown>) => {
  const { instance, requestId, traceId, ...rest } = body;
  void instance;
  void requestId;
  void traceId;
  return rest;
};

describe('Flags admin API (S38)', () => {
  let t: FlagsTestApp;
  let admin: TestUser;

  beforeAll(async () => {
    t = await createFlagsApp({ structuredLogger: true });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await t.admin();
  });

  const problem = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body);

  /** Seeds `n` disabled flags straight into the table (test code may touch every table). */
  const seed = async (n: number, prefix = 'seed') => {
    await t.sequelize.query(
      `INSERT INTO "FeatureFlag" ("key","description","status","enabled","variants","defaultVariant","offVariant","rules","bucketBy","clientSide","owner","version","createdAt","updatedAt")
       SELECT $1 || '-' || lpad(i::text, 4, '0'), '', 'disabled', false, '[{"key":"off","value":false}]'::jsonb, 'off', 'off', '[]'::jsonb,
              'userId', false, 'seed-team', 1, now(), now() FROM generate_series(1, $2::int) AS i`,
      { bind: [prefix, n] },
    );
  };

  it('S38 AS-01: creating a dark flag answers 201 with Location, the contract body, one flag row, one create audit row and ruleset +1', async () => {
    const key = t.key('new-checkout');
    const before = await t.rulesetVersion();

    const res = await t.put(admin, key, flagBody());

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/admin/flags/${key}`);
    const flag = flagSchema.parse(res.body);
    expect(flag).toMatchObject({
      key,
      status: 'disabled',
      enabled: false,
      version: 1,
      owner: 'checkout-team',
    });
    expect(await t.flagRows()).toHaveLength(1);
    const audit = await t.auditRows(key);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'create',
      before: null,
      actorId: admin.id,
    });
    expect(audit[0].after).toEqual(flag);
    expect(await t.rulesetVersion()).toBe(before + 1);
    await t.untilVersion(before + 1);
    expect(t.sdk.evaluate(key, { userId: 'anyone' })).toMatchObject({
      variant: 'off',
      reason: 'off',
    });
  });

  it('S38 AS-04: a save equal to the stored definition is a no-op (any version): same version and updatedAt, no audit, outbox or ruleset change', async () => {
    const key = t.key();
    const created = await t.create(admin, key, {
      enabled: true,
      rules: rolloutRules(5),
    });
    const updated = await t.put(
      admin,
      key,
      flagBody({ enabled: true, rules: rolloutRules(10), expectedVersion: 1 }),
    );
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);
    const version = await t.rulesetVersion();
    const audits = (await t.auditRows(key)).length;
    const outbox = (await t.outboxRows(key)).length;

    for (const expectedVersion of [2, 1, 0]) {
      const res = await t.put(
        admin,
        key,
        flagBody({ enabled: true, rules: rolloutRules(10), expectedVersion }),
      );
      expect(res.status).toBe(200);
      expect(flagSchema.parse(res.body)).toEqual(updated.body);
    }
    expect(created.version).toBe(1);
    expect(await t.rulesetVersion()).toBe(version);
    expect(await t.auditRows(key)).toHaveLength(audits);
    expect(await t.outboxRows(key)).toHaveLength(outbox);
  });

  it('S38 AS-05: a stale expectedVersion with a different definition is 409 version_conflict with currentVersion and changes nothing', async () => {
    const key = t.key();
    await t.create(admin, key, { enabled: true });
    await t
      .put(
        admin,
        key,
        flagBody({ enabled: true, owner: 'second', expectedVersion: 1 }),
      )
      .expect(200);
    const version = await t.rulesetVersion();
    const audits = (await t.auditRows(key)).length;

    const res = await t.put(
      admin,
      key,
      flagBody({ enabled: true, owner: 'third', expectedVersion: 1 }),
    );

    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('version_conflict');
    expect(res.body.currentVersion).toBe(2);
    expect((await t.flagRow(key))?.owner).toBe('second');
    expect(await t.rulesetVersion()).toBe(version);
    expect(await t.auditRows(key)).toHaveLength(audits);
  });

  it('S38 AS-06: two saves with the same expectedVersion give one 200 (version 3) and one 409, one new audit row and ruleset +1', async () => {
    const key = t.key();
    await t.create(admin, key, { enabled: true });
    await t
      .put(
        admin,
        key,
        flagBody({ enabled: true, owner: 'second', expectedVersion: 1 }),
      )
      .expect(200);
    const other = await t.admin();
    const version = await t.rulesetVersion();
    const audits = (await t.auditRows(key)).length;

    const [a, b] = await Promise.all([
      t.put(
        admin,
        key,
        flagBody({ enabled: true, owner: 'from-a', expectedVersion: 2 }),
      ),
      t.put(
        other,
        key,
        flagBody({ enabled: true, owner: 'from-b', expectedVersion: 2 }),
      ),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.version).toBe(3);
    expect(problem(loser).code).toBe('version_conflict');
    expect(await t.auditRows(key)).toHaveLength(audits + 1);
    expect(await t.rulesetVersion()).toBe(version + 1);
    expect((await t.flagRow(key))?.owner).toBe(winner.body.owner);
  });

  it('S38 AS-07: two creates of one key give one 201 and one 409 version_conflict (currentVersion 1), one row and one audit row', async () => {
    const key = t.key();
    const other = await t.admin();

    const [a, b] = await Promise.all([
      t.put(admin, key, flagBody({ owner: 'from-a' })),
      t.put(other, key, flagBody({ owner: 'from-b' })),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(problem(loser).code).toBe('version_conflict');
    expect(loser.body.currentVersion).toBe(1);
    expect(await t.flagRows()).toHaveLength(1);
    expect(await t.auditRows(key)).toHaveLength(1);
  });

  it('S38 AS-08: updating an unknown key with expectedVersion 3 is 404 flag_not_found and persists nothing', async () => {
    const version = await t.rulesetVersion();
    const res = await t.put(
      admin,
      'ghost-flag',
      flagBody({ expectedVersion: 3 }),
    );
    expect(res.status).toBe(404);
    expect(problem(res).code).toBe('flag_not_found');
    expect(await t.flagRows()).toEqual([]);
    expect(await t.auditRows('ghost-flag')).toEqual([]);
    expect(await t.rulesetVersion()).toBe(version);
  });

  describe('S38 AS-09: request-shape errors → 400 validation_failed naming the field, nothing persisted', () => {
    const without = (field: string) => {
      const body: Record<string, unknown> = flagBody();
      delete body[field];
      return body;
    };
    it.each<[string, string, Record<string, unknown>]>([
      ['missing enabled', 'enabled', without('enabled')],
      ['variants not an array', 'variants', flagBody({ variants: 'x' })],
      ['unknown extra property', 'status', flagBody({ status: 'killed' })],
      [
        'expectedVersion missing',
        'expectedVersion',
        without('expectedVersion'),
      ],
      [
        'expectedVersion negative',
        'expectedVersion',
        flagBody({ expectedVersion: -1 }),
      ],
      [
        'expectedVersion not an integer',
        'expectedVersion',
        flagBody({ expectedVersion: 1.5 }),
      ],
    ])('%s', async (_name, field, body) => {
      const version = await t.rulesetVersion();
      const res = await t.put(admin, 'shape-flag', body);
      expect(res.status).toBe(400);
      expect(problem(res).code).toBe('validation_failed');
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
        field,
      );
      expect(await t.flagRows()).toEqual([]);
      expect(await t.rulesetVersion()).toBe(version);
    });

    it.each(['Bad_Key', 'a', 'UPPER', '-lead'])(
      'a path key %s that does not match the pattern',
      async (key) => {
        const res = await t.put(admin, key, flagBody());
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
        expect(await t.flagRows()).toEqual([]);
      },
    );

    it('a 300 KiB body is 413 payload_too_large before validation and persists nothing', async () => {
      const version = await t.rulesetVersion();
      const res = await t.put(
        admin,
        'big-flag',
        flagBody({ description: 'x'.repeat(300 * 1024) }),
      );
      expect(res.status).toBe(413);
      expect(problem(res).code).toBe('payload_too_large');
      expect(await t.flagRows()).toEqual([]);
      expect(await t.rulesetVersion()).toBe(version);
    });
  });

  it('S38 AS-10: semantic problems are 422 flag_definition_invalid listing every error in one response; nothing persisted', async () => {
    const version = await t.rulesetVersion();
    const res = await t.put(
      admin,
      'semantic-flag',
      flagBody({
        defaultVariant: 'nope',
        rules: [
          {
            id: 'both',
            conditions: [],
            variant: 'on',
            rollout: [{ variant: 'on', weight: 5_000 }],
          },
          {
            id: 'sum',
            conditions: [],
            rollout: [
              { variant: 'on', weight: 5_000 },
              { variant: 'off', weight: 4_000 },
            ],
          },
        ],
      }),
    );

    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('flag_definition_invalid');
    expect(
      res.body.errors.map((e: { path: string; code: string }) => [
        e.path,
        e.code,
      ]),
    ).toEqual([
      ['defaultVariant', 'unknown_variant'],
      ['rules[0]', 'rule_target_invalid'],
      ['rules[0].rollout', 'weights_sum_invalid'],
      ['rules[1].rollout', 'weights_sum_invalid'],
    ]);
    expect(res.body.errors[3].sum).toBe(9_000);
    expect(await t.flagRows()).toEqual([]);
    expect(await t.rulesetVersion()).toBe(version);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      '21 variants',
      {
        variants: Array.from({ length: 21 }, (_, i) => ({
          key: `v${i}`,
          value: i,
        })),
        defaultVariant: 'v0',
        offVariant: 'v0',
        rules: [],
      },
      'too_many_variants',
    ],
    [
      'a variant value above 4 KiB',
      {
        variants: [
          { key: 'off', value: false },
          { key: 'on', value: { blob: 'x'.repeat(5_000) } },
        ],
      },
      'value_too_large',
    ],
  ])(
    'S38 AS-11: %s → 422 %s, nothing persisted',
    async (_name, patch, code) => {
      const res = await t.put(admin, 'limit-flag', flagBody(patch));
      expect(res.status).toBe(422);
      expect(problem(res).code).toBe('flag_definition_invalid');
      expect(res.body.errors.map((e: { code: string }) => e.code)).toContain(
        code,
      );
      expect(await t.flagRows()).toEqual([]);
    },
  );

  it('S38 AS-12: with 499 flags two simultaneous creates give one 201 and one 422 flag_limit_reached; 500 rows; archived flags do not count', async () => {
    await seed(499);
    const other = await t.admin();

    const [a, b] = await Promise.all([
      t.put(admin, t.key('race-a'), flagBody()),
      t.put(other, t.key('race-b'), flagBody()),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const loser = a.status === 422 ? a : b;
    expect(problem(loser).code).toBe('flag_limit_reached');
    expect(await t.flagRows()).toHaveLength(500);

    const again = await t.put(admin, t.key('over'), flagBody());
    expect(again.status).toBe(422);
    expect(problem(again).code).toBe('flag_limit_reached');

    await t.sequelize.query(
      `UPDATE "FeatureFlag" SET "status" = 'archived' WHERE "key" = 'seed-0001'`,
    );
    const afterArchive = await t.put(admin, t.key('fits'), flagBody());
    expect(afterArchive.status).toBe(201);
  });

  describe('S38 AS-53: admin routes without credentials → 401', () => {
    it.each<[string, string, string]>([
      ['get', '/api/admin/flags', 'list'],
      ['get', '/api/admin/flags/stale', 'stale'],
      ['get', '/api/admin/flags/some-flag', 'one'],
      ['put', '/api/admin/flags/some-flag', 'save'],
      ['post', '/api/admin/flags/some-flag/kill', 'kill'],
      ['post', '/api/admin/flags/some-flag/restore', 'restore'],
      ['post', '/api/admin/flags/some-flag/archive', 'archive'],
      ['get', '/api/admin/flags/some-flag/history', 'history'],
    ])('%s %s (%s)', async (method, path) => {
      const req = (t.http() as unknown as Record<string, (p: string) => any>)[
        method
      ](path);
      const res = await (method === 'put' ? req.send(flagBody()) : req);
      expect(res.status).toBe(401);
      expect(await t.flagRows()).toEqual([]);
    });
  });

  describe('S38 AS-54: other roles → 403 with identical bodies for existing and unknown keys; no rows changed', () => {
    const roles = [Role.USER, Role.SELLER, Role.MODERATOR];
    const routes: Array<[string, string]> = [
      ['get', ''],
      ['get', '/stale'],
      ['get', '/KEY'],
      ['put', '/KEY'],
      ['post', '/KEY/kill'],
      ['post', '/KEY/restore'],
      ['post', '/KEY/archive'],
      ['get', '/KEY/history'],
    ];
    it.each(
      roles.flatMap((role) => routes.map(([m, p]) => [role, m, p] as const)),
    )('%s %s %s', async (role, method, path) => {
      const user = await t.newUser({ role });
      const existing = t.key('exists');
      await t.create(admin, existing, { enabled: true });
      const before = await t.flagRows();
      const send = async (key: string) => {
        const agent = t.as(user) as unknown as Record<
          string,
          (p: string) => any
        >;
        const req = agent[method](
          `/api/admin/flags${path.replace('KEY', key)}`,
        );
        return method === 'put'
          ? req.send(flagBody({ expectedVersion: 1 }))
          : req;
      };
      const known = await send(existing);
      const unknown = await send('no-such-flag');
      expect(known.status).toBe(403);
      expect(unknown.status).toBe(403);
      expect(strip(known.body)).toEqual(strip(unknown.body));
      expect(await t.flagRows()).toEqual(before);
    });
  });

  it('S38 AS-55: the 31st write in a minute is 429 with Retry-After; reads are not counted', async () => {
    const key = t.key();
    await t.create(admin, key, { enabled: true });
    for (let i = 0; i < 40; i++)
      await t.as(admin).get(`/api/admin/flags/${key}`).expect(200);

    // 1 create above + 29 idempotent kills = 30 writes
    for (let i = 0; i < 29; i++)
      await t.post(admin, `/api/admin/flags/${key}/kill`).expect(204);
    const limited = await t.post(admin, `/api/admin/flags/${key}/kill`);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await t.as(admin).get(`/api/admin/flags/${key}`).expect(200);
  });

  describe('S38 AS-56: list and get', () => {
    it('lists 130 flags in pages of 50/50/30 by key; get returns one; unknown is 404', async () => {
      await seed(130);
      const first = await t.as(admin).get('/api/admin/flags').expect(200);
      const page1 = first.body;
      expect(page1.items).toHaveLength(50);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const page2 = (
        await t
          .as(admin)
          .get(
            `/api/admin/flags?cursor=${encodeURIComponent(page1.nextCursor)}`,
          )
          .expect(200)
      ).body;
      const page3 = (
        await t
          .as(admin)
          .get(
            `/api/admin/flags?cursor=${encodeURIComponent(page2.nextCursor)}`,
          )
          .expect(200)
      ).body;
      expect([page2.items.length, page3.items.length]).toEqual([50, 30]);
      expect(page3.nextCursor).toBeNull();
      const keys = [...page1.items, ...page2.items, ...page3.items].map(
        (f: { key: string }) => f.key,
      );
      expect(new Set(keys).size).toBe(130);
      expect([...keys].sort()).toEqual(keys);
      for (const item of page1.items) flagSchema.parse(item);

      const one = await t
        .as(admin)
        .get('/api/admin/flags/seed-0001')
        .expect(200);
      expect(flagSchema.parse(one.body).key).toBe('seed-0001');
      const missing = await t.as(admin).get('/api/admin/flags/ghost-flag');
      expect(missing.status).toBe(404);
      expect(problem(missing).code).toBe('flag_not_found');
    });

    it('filters by status, hides archived unless includeArchived, and bounds limit', async () => {
      await seed(3);
      await t.sequelize.query(
        `UPDATE "FeatureFlag" SET "status" = 'archived' WHERE "key" = 'seed-0003'`,
      );
      await t.sequelize.query(
        `UPDATE "FeatureFlag" SET "status" = 'enabled', "enabled" = true WHERE "key" = 'seed-0002'`,
      );
      const keysOf = async (query: string) =>
        (
          await t.as(admin).get(`/api/admin/flags${query}`).expect(200)
        ).body.items.map((f: { key: string }) => f.key);
      expect(await keysOf('')).toEqual(['seed-0001', 'seed-0002']);
      expect(await keysOf('?includeArchived=true')).toEqual([
        'seed-0001',
        'seed-0002',
        'seed-0003',
      ]);
      expect(await keysOf('?status=enabled')).toEqual(['seed-0002']);
      expect(await keysOf('?status=archived')).toEqual(['seed-0003']);
      for (const bad of ['limit=0', 'limit=201', 'limit=abc', 'status=nope']) {
        const res = await t.as(admin).get(`/api/admin/flags?${bad}`);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
      }
      const forged = await t
        .as(admin)
        .get('/api/admin/flags?cursor=garbage.sig');
      expect(forged.status).toBe(400);
      expect(problem(forged).code).toBe('invalid_cursor');
      expect(
        (await t.as(admin).get('/api/admin/flags?limit=200').expect(200)).body
          .items,
      ).toHaveLength(2);
    });
  });

  it('S38 AS-58: one admin log line per applied change carries requestId, actorId, flag key, action and flag version, and never the body', async () => {
    const key = t.key('logged');
    const res = await t.put(
      admin,
      key,
      flagBody({
        description: 'secret-description-xyz',
        variants: [
          { key: 'off', value: 'value-that-must-not-leak' },
          { key: 'on', value: true },
        ],
      }),
    );
    expect(res.status).toBe(201);

    const lines = t
      .logs()
      .filter((l) => l.event === 'flags.changed' && l.flagKey === key);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      actorId: admin.id,
      flagKey: key,
      action: 'create',
      flagVersion: 1,
    });
    expect(lines[0].requestId).toEqual(expect.any(String));
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain('secret-description-xyz');
    expect(raw).not.toContain('value-that-must-not-leak');
    expect(raw).not.toContain(admin.bearer.replace('Bearer ', ''));
  });
});
