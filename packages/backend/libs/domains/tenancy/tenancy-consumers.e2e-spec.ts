import { Module } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  addMember,
  createInvite,
  createShop,
} from '@app/test/utils/tenancy-fixtures';
import { SubscriptionPlanChanged } from './domain/events';
import { ShopPlanConsumer } from './infra/shop-plan.consumer';
import { TenancyPlanStateModule } from './tenancy-worker.module';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

@Module({
  imports: [TenancyPlanStateModule],
  providers: [ShopPlanConsumer],
  exports: [ShopPlanConsumer],
})
class PlanConsumerProbeModule {}

describe('Consumers of the tenancy domain', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;
  let consumer: ShopPlanConsumer;

  const planOf = async (shopId: string) =>
    (
      await sequelize.query<{
        plan: string;
        planVersion: string;
        shopVersion: string;
      }>(
        `SELECT "plan","planVersion","shopVersion" FROM "Shop" WHERE "id" = $1`,
        { type: QueryTypes.SELECT, bind: [shopId] },
      )
    )[0];
  const planEvents = async (shopId: string) =>
    (await outboxRowsFor(sequelize, shopId)).filter(
      (e) => e.type === 'tenancy.shop_plan_changed',
    );
  const planChanged = (
    shopId: string,
    plan: string,
    version: number,
  ): EventEnvelope =>
    SubscriptionPlanChanged.create(shopId, version, {
      shopId,
      plan: plan as 'PRO',
      version,
    });

  beforeAll(async () => {
    t = await createTenancyApp({ extraImports: [PlanConsumerProbeModule] });
    sequelize = t.app.get(Sequelize);
    consumer = t.app.get(ShopPlanConsumer);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S03 AS-73: a newer plan version changes the plan and publishes tenancy.shop_plan_changed', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    await consumer.project([planChanged(shop.id, 'PRO', 1)]);

    const row = await planOf(shop.id);
    expect(row.plan).toBe('PRO');
    expect(Number(row.planVersion)).toBe(1);
    expect(Number(row.shopVersion)).toBe(2);
    const events = await planEvents(shop.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.payload).toEqual({
      shopId: shop.id,
      plan: 'PRO',
      shopVersion: 2,
    });
  });

  it('S03 AS-73: an older or equal version is ignored and a duplicate delivery changes nothing', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    const event = planChanged(shop.id, 'ENTERPRISE', 5);
    await consumer.project([event]);
    const after = await planOf(shop.id);

    const counts = await consumer.project([
      event,
      planChanged(shop.id, 'STARTER', 4),
      planChanged(shop.id, 'PRO', 5),
    ]);
    expect(counts).toEqual({ applied: 0, duplicate: 0, stale: 3 });
    expect(await planOf(shop.id)).toEqual(after);
    expect(after.plan).toBe('ENTERPRISE');
    expect(await planEvents(shop.id)).toHaveLength(1);
  });

  it('S03 AS-73: an invalid plan is a permanent failure for the dead-letter topic and changes nothing', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    const poison = {
      ...planChanged(shop.id, 'PRO', 2),
      payload: { shopId: shop.id, plan: 'PLATINUM', version: 2 },
    } as EventEnvelope;
    await expect(consumer.project([poison])).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect((await planOf(shop.id)).plan).toBe('STARTER');
    await expect(
      consumer.project([
        {
          ...planChanged(shop.id, 'PRO', 2),
          payload: { shopId: uuidv7() },
        } as EventEnvelope,
      ]),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(await planEvents(shop.id)).toHaveLength(0);
  });

  it('S03 AS-73: raising the plan lets an invite through that the old seat limit refused; lowering it removes nobody', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    for (let i = 0; i < 4; i++)
      await addMember(t.app, shop.id, (await t.newUser()).id, 'STAFF');
    await createInvite(t.app, shop.id, {
      email: 'pending@example.com',
      invitedBy: owner.id,
    });
    const invite = () =>
      t
        .as(owner)
        .post(`/api/shops/${shop.id}/invites`)
        .send({ email: 'next@example.com', role: 'STAFF' });
    await invite().expect(409);

    await consumer.project([planChanged(shop.id, 'PRO', 1)]);
    await invite().expect(201);

    await consumer.project([planChanged(shop.id, 'STARTER', 2)]);
    const members = await t.as(owner).get(`/api/shops/${shop.id}/members`);
    expect(members.body.items).toHaveLength(5);
    await t
      .as(owner)
      .post(`/api/shops/${shop.id}/invites`)
      .send({ email: 'again@example.com', role: 'STAFF' })
      .expect(409);
  });
});
