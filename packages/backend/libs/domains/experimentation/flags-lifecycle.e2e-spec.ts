import {
  flagChangedEventSchema,
  flagSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  createFlagsApp,
  flagBody,
  rolloutRules,
  type FlagsTestApp,
} from './testing/flags.fixtures';

describe('Flag lifecycle and kill switch (S38)', () => {
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

  const problem = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body);
  const kill = (key: string, as: TestUser = admin) =>
    t.post(as, `/api/admin/flags/${key}/kill`);
  const restore = (key: string) =>
    t.post(admin, `/api/admin/flags/${key}/restore`);
  const archive = (key: string) =>
    t.post(admin, `/api/admin/flags/${key}/archive`);
  const status = async (key: string) => (await t.flagRow(key))?.status;
  const staff = {
    id: 'staff',
    conditions: [
      { attribute: 'email_domain', op: 'in', values: ['marketplace.dev'] },
    ],
    variant: 'on',
  };

  it('S38 AS-30: kill answers 204, keeps the rules, writes one kill audit row and one outbox event, and turns the flag off everywhere within 1 s, staff included', async () => {
    const key = t.key('killable');
    await t.create(admin, key, {
      enabled: true,
      rules: [staff, ...rolloutRules(100)],
    });
    await t.untilVersion(await t.rulesetVersion());
    expect(
      t.sdk.evaluate(key, { userId: 'u', email_domain: 'marketplace.dev' })
        .value,
    ).toBe(true);
    const before = await t.rulesetVersion();

    const res = await kill(key);

    expect(res.status).toBe(204);
    expect(await status(key)).toBe('killed');
    const row = await t.flagRow(key);
    expect(row?.rules).toHaveLength(2);
    expect(row?.enabled).toBe(false);
    const audit = await t.auditRows(key);
    expect(audit.filter((a) => a.action === 'kill')).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'kill', actorId: admin.id });
    expect(audit[0].before.status).toBe('enabled');
    expect(audit[0].after.status).toBe('killed');
    const events = await t.outboxRows(key);
    expect(events).toHaveLength(2);
    const parsed = flagChangedEventSchema.parse(
      typeof events[1].payload === 'string'
        ? JSON.parse(events[1].payload)
        : events[1].payload,
    );
    expect(parsed.payload).toMatchObject({ flagKey: key, action: 'kill' });
    expect(await t.rulesetVersion()).toBe(before + 1);

    await t.untilVersion(before + 1);
    for (const ctx of [
      { userId: 'u1' },
      { userId: 'u2', email_domain: 'marketplace.dev' },
    ])
      expect(t.sdk.evaluate(key, ctx)).toMatchObject({
        variant: 'off',
        value: false,
        reason: 'killed',
      });
  });

  it('S38 AS-31: killing again, sequentially or at once, changes nothing: one audit row, version and ruleset unchanged', async () => {
    const key = t.key();
    await t.create(admin, key, { enabled: true });
    await kill(key).expect(204);
    const flag = await t.flagRow(key);
    const version = await t.rulesetVersion();
    const audits = (await t.auditRows(key)).length;
    const events = (await t.outboxRows(key)).length;

    await kill(key).expect(204);
    const other = await t.admin();
    const results = await Promise.all([kill(key), kill(key, other), kill(key)]);

    expect(results.map((r) => r.status)).toEqual([204, 204, 204]);
    expect((await t.flagRow(key))?.version).toBe(flag?.version);
    expect((await t.flagRow(key))?.updatedAt).toEqual(flag?.updatedAt);
    expect(await t.rulesetVersion()).toBe(version);
    expect(await t.auditRows(key)).toHaveLength(audits);
    expect(await t.outboxRows(key)).toHaveLength(events);
  });

  it('S38 AS-31: concurrent first kills of an enabled flag apply once', async () => {
    const key = t.key();
    await t.create(admin, key, { enabled: true });
    const version = await t.rulesetVersion();

    const results = await Promise.all([kill(key), kill(key), kill(key)]);

    expect(results.map((r) => r.status)).toEqual([204, 204, 204]);
    expect(
      (await t.auditRows(key)).filter((a) => a.action === 'kill'),
    ).toHaveLength(1);
    expect(await t.rulesetVersion()).toBe(version + 1);
  });

  it('S38 AS-32: killing an unknown flag is 404 flag_not_found; an archived one is 409 flag_archived', async () => {
    const missing = await kill('ghost-flag');
    expect(missing.status).toBe(404);
    expect(problem(missing).code).toBe('flag_not_found');

    const key = t.key();
    await t.create(admin, key);
    await archive(key).expect(204);
    const archived = await kill(key);
    expect(archived.status).toBe(409);
    expect(problem(archived).code).toBe('flag_archived');
    expect(await status(key)).toBe('archived');
  });

  it('S38 AS-33: a kill racing a save of enabled:true always ends killed (20 rounds); both allowed outcomes are counted', async () => {
    let savedThenKilled = 0;
    let killedThenRefused = 0;
    for (let round = 0; round < 20; round++) {
      // A fresh admin per round: the write limit (30 a minute) is per admin and is not what this test is about.
      const key = t.key('race');
      const roundAdmin = await t.admin();
      await t.create(roundAdmin, key, { enabled: false });
      const other = await t.admin();

      const [killed, saved] = await Promise.all([
        kill(key, roundAdmin),
        t.put(other, key, flagBody({ enabled: true, expectedVersion: 1 })),
      ]);

      expect(killed.status).toBe(204);
      expect(await status(key)).toBe('killed');
      expect((await t.flagRow(key))?.enabled).toBe(false);
      if (saved.status === 200) savedThenKilled++;
      else {
        expect(saved.status).toBe(409);
        expect(['version_conflict', 'flag_killed']).toContain(
          problem(saved).code,
        );
        killedThenRefused++;
      }
    }
    expect(savedThenKilled + killedThenRefused).toBe(20);
  });

  it('S38 AS-34: saving enabled:true on a killed flag is 409 flag_killed; enabled:false is accepted and the flag stays killed', async () => {
    const key = t.key();
    await t.create(admin, key, { enabled: true });
    await kill(key).expect(204);
    const killed = await t.flagRow(key);

    const enable = await t.put(
      admin,
      key,
      flagBody({ enabled: true, expectedVersion: killed?.version }),
    );
    expect(enable.status).toBe(409);
    expect(problem(enable).code).toBe('flag_killed');
    expect(await status(key)).toBe('killed');

    const edit = await t.put(
      admin,
      key,
      flagBody({
        enabled: false,
        owner: 'someone-else',
        expectedVersion: killed?.version,
      }),
    );
    expect(edit.status).toBe(200);
    expect(flagSchema.parse(edit.body)).toMatchObject({
      status: 'killed',
      owner: 'someone-else',
      version: (killed?.version as number) + 1,
    });
  });

  it('S38 AS-35: restore moves killed to disabled with a restore audit row; from any other state it is 409 invalid_transition with currentStatus', async () => {
    const key = t.key();
    await t.create(admin, key, { enabled: true });

    const fromEnabled = await restore(key);
    expect(fromEnabled.status).toBe(409);
    expect(problem(fromEnabled).code).toBe('invalid_transition');
    expect(fromEnabled.body.currentStatus).toBe('enabled');

    await kill(key).expect(204);
    await restore(key).expect(204);
    expect(await status(key)).toBe('disabled');
    expect((await t.auditRows(key))[0]).toMatchObject({ action: 'restore' });
    expect((await t.flagRow(key))?.enabled).toBe(false);

    const fromDisabled = await restore(key);
    expect(fromDisabled.status).toBe(409);
    expect(fromDisabled.body.currentStatus).toBe('disabled');

    const missing = await restore('ghost-flag');
    expect(missing.status).toBe(404);
  });

  it('S38 AS-36: archive moves disabled/killed to archived (idempotent), removes the flag from the ruleset and default list, keeps its history, and reserves the key', async () => {
    const key = t.key('arch');
    await t.create(admin, key, { enabled: true });

    const fromEnabled = await archive(key);
    expect(fromEnabled.status).toBe(409);
    expect(problem(fromEnabled).code).toBe('invalid_transition');
    expect(fromEnabled.body.currentStatus).toBe('enabled');

    await kill(key).expect(204);
    await archive(key).expect(204);
    expect(await status(key)).toBe('archived');
    const audits = await t.auditRows(key);
    expect(audits[0]).toMatchObject({ action: 'archive' });
    const version = await t.rulesetVersion();

    await archive(key).expect(204);
    expect(await t.auditRows(key)).toHaveLength(audits.length);
    expect(await t.rulesetVersion()).toBe(version);

    expect((await t.cachedSnapshot())?.flags.map((f) => f.key)).not.toContain(
      key,
    );
    await t.untilVersion(version);
    expect(t.sdk.evaluate(key, { userId: 'u' }).reason).toBe('unknown_flag');

    const list = (key_: string) =>
      t.as(admin).get(`/api/admin/flags${key_}`).expect(200);
    expect(
      (await list('')).body.items.map((f: { key: string }) => f.key),
    ).not.toContain(key);
    expect(
      (await list('?includeArchived=true')).body.items.map(
        (f: { key: string }) => f.key,
      ),
    ).toContain(key);
    const history = await t
      .as(admin)
      .get(`/api/admin/flags/${key}/history`)
      .expect(200);
    expect(history.body.items.length).toBe(audits.length);

    const save = await t.put(admin, key, flagBody({ expectedVersion: 3 }));
    expect(save.status).toBe(409);
    expect(problem(save).code).toBe('flag_archived');
    const recreate = await t.put(admin, key, flagBody());
    expect(recreate.status).toBe(409);
    expect(problem(recreate).code).toBe('flag_archived');
  });

  it('S38 AS-36: a disabled flag can be archived directly', async () => {
    const key = t.key();
    await t.create(admin, key, { enabled: false });
    await archive(key).expect(204);
    expect(await status(key)).toBe('archived');
  });
});
