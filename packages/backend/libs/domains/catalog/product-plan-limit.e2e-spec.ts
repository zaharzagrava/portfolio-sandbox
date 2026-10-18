import { HttpStatus } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { EntitlementsService } from '@app/domains/billing';
import { AppError, ErrorArea } from '@app/common/errors';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  catalogEventCount,
  createShopWorld,
  type ShopWorld,
} from './testing/catalog-spec-kit';

/** What S18 answers for `maxProducts`, as a spec sets it (the real service is proved in billing's own e2e). */
const plan = { limit: 2, unavailable: false, asked: [] as number[] };

const fakeEntitlements = {
  checkLimit: async (
    _type: string,
    _subjectId: string,
    _key: string,
    current: number,
  ) => {
    plan.asked.push(current);
    if (plan.unavailable)
      throw new AppError({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'entitlements_unavailable',
        title: 'Service Unavailable',
        detail: 'Entitlements could not be determined.',
        area: ErrorArea.DOMAIN,
      });
    return {
      allowed: current < plan.limit,
      limit: plan.limit,
      remaining: Math.max(0, plan.limit - current),
    };
  },
};

// every test title below carries `S05 G-20` (the id the S05 page cites)
describe('Product create: the plan limit (J02 FR-010)', () => {
  let t: CatalogTestApp;
  let w: ShopWorld;
  let sql: Sequelize;

  const create = (title: string, shopId = w.shop.id, who = w.owner) =>
    t.as(who).post(`/api/shops/${shopId}/products`).send({
      title,
      brand: 'Acme',
      category: 'electronics',
      priceMinor: 1500,
      quantity: 1,
    });
  const liveCount = async (shopId = w.shop.id) =>
    Number(
      (
        await sql.query<{ n: string }>(
          `SELECT count(*) AS n FROM "Product" WHERE "shopId" = :shopId AND "status" = 'ACTIVE'`,
          { type: QueryTypes.SELECT, replacements: { shopId } },
        )
      )[0].n,
    );

  beforeAll(async () => {
    t = await createCatalogApp({
      overrides: [{ provide: EntitlementsService, useValue: fakeEntitlements }],
    });
    sql = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    plan.limit = 2;
    plan.unavailable = false;
    plan.asked.length = 0;
    w = await createShopWorld(t);
  });

  it('S05 G-20: the product after the limit is 409 plan_limit_reached {key, limit} and nothing is written', async () => {
    await create('One').expect(201);
    await create('Two').expect(201);
    const events = await catalogEventCount(t.app);

    const refused = await create('Three').expect(409);
    expect(refused.body).toMatchObject({
      code: 'plan_limit_reached',
      status: 409,
      key: 'maxProducts',
      limit: 2,
    });
    expect(await liveCount()).toBe(2);
    expect(await catalogEventCount(t.app)).toBe(events);
  });

  it('S05 G-20: archived products do not count, and another shop has its own count', async () => {
    const one = await create('One').expect(201);
    await create('Two').expect(201);
    await create('Three').expect(409);
    await t
      .as(w.owner)
      .post(`/api/shops/${w.shop.id}/products/${one.body.id}/archive`)
      .send({ expectedVersion: one.body.version })
      .expect(200);
    await create('Three').expect(201);

    const other = await createShopWorld(t);
    await create('Elsewhere', other.shop.id, other.owner).expect(201);
  });

  it('S05 G-20: when the entitlements cannot be determined the create fails closed with 503 and writes nothing', async () => {
    plan.unavailable = true;
    const refused = await create('Never').expect(503);
    expect(refused.body.code).toBe('entitlements_unavailable');
    expect(await liveCount()).toBe(0);
  });

  it('S05 G-20: eight concurrent creates never exceed the limit', async () => {
    plan.limit = 3;
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, i) => create(`Race ${i}`)),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(3);
    expect(replies.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await liveCount()).toBe(3);
  });
});
