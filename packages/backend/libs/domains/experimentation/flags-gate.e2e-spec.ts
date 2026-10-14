import { Controller, Get, Module } from '@nestjs/common';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { AuthModule, Firewall } from '@app/domains/identity';
import { waitFor } from '@app/test/utils/async-helpers';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import type { TestUser } from '@app/test/utils/catalog-app';
import { RequireFlag } from './api/flags.guard';
import {
  createFlagsApp,
  flagBody,
  rolloutRules,
  type FlagsTestApp,
} from './testing/flags.fixtures';

const GATE = 'gate-demo-flag';
const SHOP_GATE = 'gate-shop-flag';

/** The routes of this spec: two handlers behind a flag, as another capability would write them. */
@Controller('gate-demo')
class GateDemoController {
  @RequireFlag(GATE)
  @Firewall({ anonymous: true })
  @Get('feature')
  feature() {
    return { handler: 'ran' };
  }

  @RequireFlag(SHOP_GATE)
  @Firewall({ anonymous: true })
  @Get('shop-feature')
  shopFeature() {
    return { handler: 'ran' };
  }
}

@Module({ imports: [AuthModule], controllers: [GateDemoController] })
class GateDemoModule {}

/** A problem body without what differs per request: its instance, request id, trace id and the URL echoed in `detail`. */
const strip = (body: Record<string, unknown>) => {
  const { instance, requestId, traceId, detail, ...rest } = body;
  void instance;
  void requestId;
  void traceId;
  return {
    ...rest,
    detail: String(detail).replace(/(Cannot [A-Z]+) \S+$/, '$1 <url>'),
  };
};

describe('RequireFlag route gate (S38)', () => {
  let t: FlagsTestApp;
  let admin: TestUser;

  beforeAll(async () => {
    t = await createFlagsApp({ extraImports: [GateDemoModule] });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await t.admin();
  });

  const feature = (as?: TestUser, headers: Record<string, string> = {}) => {
    let req = as
      ? t.as(as).get('/api/gate-demo/feature')
      : t.http().get('/api/gate-demo/feature');
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req;
  };
  const converged = async () => t.untilVersion(await t.rulesetVersion());
  const problem = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body);

  it('S38 AS-51: a gated route is 404 exactly like an undefined route until its flag is on; unknown, archived, disabled and killed flags gate closed; a kill closes it within 1 s', async () => {
    const undefinedRoute = await t.http().get('/api/gate-demo/no-such-route');
    expect(undefinedRoute.status).toBe(404);

    // unknown flag
    const unknown = await feature();
    expect(unknown.status).toBe(404);
    expect(strip(unknown.body)).toEqual(strip(undefinedRoute.body));
    expect(problem(unknown).code).toBe('not_found');

    // disabled
    await t.create(admin, GATE, { enabled: false, rules: rolloutRules(100) });
    await converged();
    const off = await feature();
    expect(off.status).toBe(404);
    expect(strip(off.body)).toEqual(strip(undefinedRoute.body));

    // enabled for everyone: the handler runs
    await t
      .put(
        admin,
        GATE,
        flagBody({
          enabled: true,
          rules: rolloutRules(100),
          expectedVersion: 1,
        }),
      )
      .expect(200);
    await converged();
    const on = await feature();
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ handler: 'ran' });

    // kill closes it within a second
    await t.post(admin, `/api/admin/flags/${GATE}/kill`).expect(204);
    await waitFor(async () => (await feature()).status === 404, {
      timeoutMs: 1_000,
      intervalMs: 20,
    });
    const killed = await feature();
    expect(strip(killed.body)).toEqual(strip(undefinedRoute.body));

    // archived
    await t.post(admin, `/api/admin/flags/${GATE}/archive`).expect(204);
    await converged();
    expect((await feature()).status).toBe(404);
  });

  it('S38 AS-51: a rollout flag opens the route for the callers it selects only', async () => {
    await t.create(admin, GATE, {
      enabled: true,
      rules: [
        {
          id: 'staff',
          conditions: [{ attribute: 'role', op: 'eq', values: ['ADMIN'] }],
          variant: 'on',
        },
      ],
    });
    await converged();

    expect((await feature(admin)).status).toBe(200);
    const user = await t.newUser();
    expect((await feature(user)).status).toBe(404);
    expect((await feature()).status).toBe(404);
  });

  it('S38 AS-52: a shop allowlist opens the route for members of the listed shop and keeps it 404 for another shop', async () => {
    const ownerA = await t.newUser();
    const ownerC = await t.newUser();
    const shopA = await createShop(t.app, ownerA);
    const shopC = await createShop(t.app, ownerC);
    await t.create(admin, SHOP_GATE, {
      enabled: true,
      bucketBy: 'shopId',
      rules: [
        {
          id: 'allow',
          conditions: [{ attribute: 'shopId', op: 'in', values: [shopA.id] }],
          variant: 'on',
        },
      ],
    });
    await converged();
    const get = (as: TestUser, shop: string) =>
      t.as(as).get('/api/gate-demo/shop-feature').set('X-Shop-Id', shop);

    expect((await get(ownerA, shopA.id)).status).toBe(200);
    expect((await get(ownerC, shopC.id)).status).toBe(404);
    // naming shop A without being a member does not open the gate
    expect((await get(ownerC, shopA.id)).status).toBe(404);
    expect((await t.as(ownerC).get('/api/gate-demo/shop-feature')).status).toBe(
      404,
    );
    const staffOfA = await t.newUser();
    await addMember(t.app, shopA.id, staffOfA.id, 'STAFF');
    expect((await get(staffOfA, shopA.id)).status).toBe(200);
  });
});
