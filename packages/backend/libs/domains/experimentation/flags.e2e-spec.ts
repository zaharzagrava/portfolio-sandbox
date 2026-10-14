import type { TestUser } from '@app/test/utils/catalog-app';
import {
  createFlagsApp,
  flagBody,
  rolloutRules,
  type FlagsTestApp,
} from './testing/flags.fixtures';

/** The journey in one place: admin write -> audit -> published ruleset -> in-process SDK -> public endpoint. */
describe('Feature flags journey (S38)', () => {
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

  it('S38 AS-14: a saved flag reaches the SDK by push; 50% rollout is ~half the users and sticky; the kill switch turns it off everywhere and is audited', async () => {
    const key = t.key('checkout');
    await t.create(admin, key, { enabled: true, rules: rolloutRules(50) });
    await t.untilVersion(await t.rulesetVersion());

    const users = Array.from({ length: 2_000 }, (_, i) => `u${i}`);
    const on = users.filter((u) => t.sdk.isEnabled(key, { userId: u }));
    expect(on.length / users.length).toBeGreaterThan(0.45);
    expect(on.length / users.length).toBeLessThan(0.55);
    expect(on.every((u) => t.sdk.isEnabled(key, { userId: u }))).toBe(true);

    await t.post(admin, `/api/admin/flags/${key}/kill`).expect(204);
    await t.untilVersion(await t.rulesetVersion());
    expect(users.some((u) => t.sdk.isEnabled(key, { userId: u }))).toBe(false);

    const actions = (await t.auditRows(key)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'kill']));
  });

  it("S38 AS-17: an invalid definition is rejected with 422 and unknown flags fall back to the caller's default", async () => {
    const res = await t.put(
      admin,
      t.key('broken'),
      flagBody({ defaultVariant: 'nope' }),
    );
    expect(res.status).toBe(422);
    expect(t.sdk.value('does-not-exist', { userId: 'u' }, 'fallback')).toBe(
      'fallback',
    );
  });

  it('S38 AS-37: GET /api/flags exposes only client-side flags, pre-evaluated, never the rules', async () => {
    const shown = t.key('web');
    const hidden = t.key('server');
    await t.create(admin, shown, {
      enabled: true,
      clientSide: true,
      rules: rolloutRules(100),
    });
    await t.create(admin, hidden, { enabled: true, rules: rolloutRules(100) });
    await t.untilVersion(await t.rulesetVersion());

    const res = await t
      .http()
      .get('/api/flags')
      .set('X-Anonymous-Id', 'anon-0001');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.flags)).toEqual([shown]);
    expect(JSON.stringify(res.body)).not.toContain('rollout');
  });

  it('S38 AS-48: the stale report lists an expired flag nobody evaluates', async () => {
    const key = t.key('forgotten');
    await t.create(admin, key, { enabled: false });
    await t.sequelize.query(
      `UPDATE "FeatureFlag" SET "expiresAt" = $2 WHERE "key" = $1`,
      { bind: [key, new Date(t.clock.now().getTime() - 86_400_000)] },
    );

    const res = await t.as(admin).get('/api/admin/flags/stale');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({ key, expired: true, evaluations: 0 }),
    ]);
  });
});
