import {
  clientFlagsSchema,
  flagsResponseSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { waitFor } from '@app/test/utils/async-helpers';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import type { TestUser } from '@app/test/utils/catalog-app';
import { bucketOf } from './domain/bucket';
import {
  createFlagsApp,
  flagBody,
  rolloutRules,
  type FlagsTestApp,
} from './testing/flags.fixtures';

const EDGE_SECRET = 'test-flags-edge-secret-0123456789abcdef';

describe('Client flags endpoint (S38)', () => {
  let t: FlagsTestApp;
  let admin: TestUser;

  beforeAll(async () => {
    t = await createFlagsApp({ env: { FLAGS_EDGE_SECRET: EDGE_SECRET } });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await t.admin();
  });

  /** Creates a client-side flag and waits until the app's SDK serves it. */
  const clientFlag = async (
    patch: Record<string, unknown> = {},
    key = t.key('web'),
  ) => {
    await t.create(admin, key, {
      enabled: true,
      clientSide: true,
      rules: rolloutRules(100),
      ...patch,
    });
    await t.untilVersion(await t.rulesetVersion());
    return key;
  };
  const anonymous = (headers: Record<string, string> = {}) => {
    let req = t.http().get('/api/flags');
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req;
  };

  it('S38 AS-37: the public endpoint returns only the client-side flags, pre-evaluated, with private no-store caching; an admin sees the same', async () => {
    const shown = await clientFlag();
    const off = await clientFlag({ enabled: false });
    const hidden = await clientFlag({ clientSide: false });
    const killed = await clientFlag();
    await t.post(admin, `/api/admin/flags/${killed}/kill`).expect(204);
    await t.untilVersion(await t.rulesetVersion());

    const res = await anonymous({ 'X-Anonymous-Id': 'visitor-0001' });

    expect(res.status).toBe(200);
    const body = clientFlagsSchema.parse(res.body);
    expect(body).toEqual({
      version: t.sdk.version,
      flags: {
        [shown]: { variant: 'on', value: true },
        [off]: { variant: 'off', value: false },
        [killed]: { variant: 'off', value: false },
      },
    });
    expect(Object.keys(body.flags)).not.toContain(hidden);
    for (const secret of [
      'rollout',
      'rules',
      'owner',
      'checkout-team',
      'description',
      'a test flag',
    ])
      expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers.vary).toMatch(/Authorization/i);
    expect(res.headers.vary).toMatch(/X-Anonymous-Id/i);

    const asAdmin = await t
      .as(admin)
      .get('/api/flags')
      .set('X-Anonymous-Id', 'visitor-0001');
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toEqual(res.body);
  });

  it('S38 AS-37: a real body parses with the schema the BFF validates upstream answers with (same exported name, S48 follow-up)', async () => {
    const key = await clientFlag();
    const res = await anonymous({ 'X-Anonymous-Id': 'visitor-0001' }).expect(
      200,
    );

    expect(flagsResponseSchema.parse(res.body).flags[key]).toEqual({
      variant: 'on',
      value: true,
    });
    expect(flagsResponseSchema).toBe(clientFlagsSchema);
  });

  it('S38 AS-38: the answer is sticky per visitor and per user across devices, and flipping clientSide removes the key within 1 s', async () => {
    const key = await clientFlag({ rules: rolloutRules(50) });
    const ids = Array.from(
      { length: 40 },
      (_, i) => `visitor-${i.toString().padStart(4, '0')}`,
    );
    const variantOf = async (id: string) =>
      (await anonymous({ 'X-Anonymous-Id': id }).expect(200)).body.flags[key]
        .variant;
    const first = await Promise.all(ids.map(variantOf));
    expect(new Set(first)).toEqual(new Set(['on', 'off']));
    expect(await Promise.all(ids.map(variantOf))).toEqual(first);

    const user = await t.newUser();
    const phone = await t
      .as(user)
      .get('/api/flags')
      .set('X-Anonymous-Id', 'phone-device-1')
      .expect(200);
    const laptop = await t
      .as(user)
      .get('/api/flags')
      .set('X-Anonymous-Id', 'laptop-device-2')
      .expect(200);
    expect(phone.body.flags[key]).toEqual(laptop.body.flags[key]);

    const current = await t.flagRow(key);
    await t
      .put(
        admin,
        key,
        flagBody({
          enabled: true,
          clientSide: false,
          rules: rolloutRules(50),
          expectedVersion: current?.version,
        }),
      )
      .expect(200);
    await waitFor(
      async () =>
        !(key in (await anonymous({ 'X-Anonymous-Id': ids[0] })).body.flags),
      { timeoutMs: 1_000, intervalMs: 20 },
    );
  });

  describe('S38 AS-39: a client cannot choose its tenant, user or role', () => {
    it('ignores X-Shop-Id from a visitor, ?shopId, X-User-Id and X-User-Role; a verified member gets the shop variant', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const outsider = await t.newUser();
      const shopFlag = await clientFlag({
        bucketBy: 'shopId',
        rules: [
          {
            id: 'allow',
            conditions: [{ attribute: 'shopId', op: 'in', values: [shop.id] }],
            variant: 'on',
          },
        ],
      });
      const roleFlag = await clientFlag({
        rules: [
          {
            id: 'admins',
            conditions: [{ attribute: 'role', op: 'eq', values: ['ADMIN'] }],
            variant: 'on',
          },
        ],
      });
      const variants = (res: { body: any }) => [
        res.body.flags[shopFlag].variant,
        res.body.flags[roleFlag].variant,
      ];

      expect(
        variants(
          await anonymous({
            'X-Shop-Id': shop.id,
            'X-Anonymous-Id': 'visitor-0001',
          }).expect(200),
        ),
      ).toEqual(['off', 'off']);
      expect(
        variants(
          await t.http().get(`/api/flags?shopId=${shop.id}`).expect(200),
        ),
      ).toEqual(['off', 'off']);
      expect(
        variants(
          await anonymous({
            'X-User-Id': admin.id,
            'X-User-Role': 'ADMIN',
            'X-Anonymous-Id': 'visitor-0001',
          }).expect(200),
        ),
      ).toEqual(['off', 'off']);
      const signedInUser = await t
        .as(outsider)
        .get('/api/flags')
        .set('X-User-Role', 'ADMIN')
        .expect(200);
      expect(variants(signedInUser)).toEqual(['off', 'off']);

      const spoofed = await t
        .as(outsider)
        .get('/api/flags')
        .set('X-Shop-Id', shop.id)
        .expect(200);
      expect(variants(spoofed)).toEqual(['off', 'off']);

      const member = await t
        .as(owner)
        .get('/api/flags')
        .set('X-Shop-Id', shop.id)
        .expect(200);
      expect(variants(member)).toEqual(['on', 'off']);
      const viewer = await t.newUser();
      await addMember(t.app, shop.id, viewer.id, 'VIEWER');
      const asViewer = await t
        .as(viewer)
        .get('/api/flags')
        .set('X-Shop-Id', shop.id)
        .expect(200);
      expect(variants(asViewer)).toEqual(['on', 'off']);

      const realAdmin = await t.as(admin).get('/api/flags').expect(200);
      expect(variants(realAdmin)).toEqual(['off', 'on']);
    });
  });

  describe('S38 AS-40: an invalid anonymous id is ignored and gets the first-slice variant', () => {
    const rollout = [
      {
        id: 'r',
        conditions: [],
        rollout: [
          { variant: 'off', weight: 5_000 },
          { variant: 'on', weight: 5_000 },
        ],
      },
    ];
    it.each([
      ['too short', 'abc'],
      ['too long', 'a'.repeat(65)],
      ['illegal characters', 'bad id with spaces!'],
      ['non-ascii', 'visitor-é-0001'],
    ])('%s', async (_name, id) => {
      const key = await clientFlag({ rules: rollout });
      const res = await anonymous({ 'X-Anonymous-Id': id });
      expect(res.status).toBe(200);
      expect(res.body.flags[key]).toEqual({ variant: 'off', value: false });
    });

    it('a valid id is the bucketing unit (one landing in the second slice is served on)', async () => {
      const key = await clientFlag({ rules: rollout });
      const id = Array.from(
        { length: 200 },
        (_, i) => `visitor-${i.toString().padStart(4, '0')}`,
      ).find((c) => bucketOf(key, c) >= 5_000) as string;
      const res = await anonymous({ 'X-Anonymous-Id': id }).expect(200);
      expect(res.body.flags[key].variant).toBe('on');
    });
  });

  it('S38 AS-41: country is honoured only with the edge credential, and platform only from web, ios, android', async () => {
    const country = await clientFlag({
      rules: [
        {
          id: 'de',
          conditions: [{ attribute: 'country', op: 'in', values: ['DE'] }],
          variant: 'on',
        },
      ],
    });
    const platform = await clientFlag({
      rules: [
        {
          id: 'ios',
          conditions: [{ attribute: 'platform', op: 'eq', values: ['ios'] }],
          variant: 'on',
        },
      ],
    });
    const variants = (res: { body: any }) => [
      res.body.flags[country].variant,
      res.body.flags[platform].variant,
    ];

    const trusted = await anonymous({
      'cf-ipcountry': 'DE',
      'x-edge-credential': EDGE_SECRET,
      'x-client-platform': 'ios',
    }).expect(200);
    expect(variants(trusted)).toEqual(['on', 'on']);

    const noCredential = await anonymous({
      'cf-ipcountry': 'DE',
      'x-client-platform': 'ios',
    }).expect(200);
    expect(variants(noCredential)).toEqual(['off', 'on']);
    const wrongCredential = await anonymous({
      'cf-ipcountry': 'DE',
      'x-edge-credential': 'x'.repeat(EDGE_SECRET.length),
    }).expect(200);
    expect(variants(wrongCredential)).toEqual(['off', 'off']);

    const toaster = await anonymous({
      'cf-ipcountry': 'DE',
      'x-edge-credential': EDGE_SECRET,
      'x-client-platform': 'toaster',
    }).expect(200);
    expect(variants(toaster)).toEqual(['on', 'off']);
  });

  it('S38 AS-42: the 121st request in a minute is 429 with Retry-After', async () => {
    await clientFlag();
    const visitor = { 'X-Anonymous-Id': 'visitor-limit' };
    for (let batch = 0; batch < 4; batch++)
      await Promise.all(
        Array.from({ length: 30 }, () => anonymous(visitor).expect(200)),
      );

    const limited = await anonymous(visitor);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(problemDetailsSchema.parse(limited.body).code).toBe('rate_limited');
  });
});
