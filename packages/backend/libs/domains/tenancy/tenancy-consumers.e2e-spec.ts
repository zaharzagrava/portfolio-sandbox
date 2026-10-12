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
import { TransactionRunner } from '@app/infrastructure/context';
import { InboxModule, InboxService } from '@app/infrastructure/inbox';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { SubscriptionPlanChanged } from './domain/events';
import { ShopPlanConsumer } from './infra/shop-plan.consumer';
import { VerificationProjector } from './infra/projectors/verification.projector';
import { TenancyPlanStateModule } from './tenancy-worker.module';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

@Module({
  imports: [TenancyPlanStateModule, InboxModule],
  providers: [ShopPlanConsumer, VerificationProjector],
  exports: [ShopPlanConsumer, VerificationProjector],
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

  describe('S03 AS-72: seller verification events', () => {
    let verification: VerificationProjector;
    type Kind = 'submitted' | 'verified' | 'rejected';
    const TYPES: Record<Kind, string> = {
      submitted: 'shop.onboarding_submitted',
      verified: 'shop.verified',
      rejected: 'shop.rejected',
    };
    const event = (kind: Kind, shopId: string, eventId = uuidv7()) =>
      ({
        eventId,
        type: TYPES[kind],
        version: 1,
        aggregateType: 'shops',
        aggregateId: shopId,
        aggregateVersion: 1,
        occurredAt: new Date().toISOString(),
        // the producer sends more than tenancy reads
        payload: { shopId, country: 'DE', verifiedAt: 'x' },
      }) as EventEnvelope;
    /** What the projection framework does for `idempotency: 'inbox'`. */
    const deliver = (raw: EventEnvelope) =>
      t.app.get(TransactionRunner).run(async () => {
        if (
          await t.app
            .get(InboxService)
            .recordOnce(verification.name, raw.eventId)
        )
          return verification.project([raw]);
        return { applied: 0, duplicate: 1, stale: 0 };
      });
    const state = async (shopId: string) =>
      (
        await sequelize.query<{
          verificationStatus: string;
          payoutsEnabled: boolean;
          shopVersion: string;
        }>(
          `SELECT "verificationStatus","payoutsEnabled","shopVersion" FROM "Shop" WHERE "id" = $1`,
          { type: QueryTypes.SELECT, bind: [shopId] },
        )
      )[0];
    const changed = async (shopId: string) =>
      (await outboxRowsFor(sequelize, shopId))
        .filter((e) => e.type === 'tenancy.shop_verification_changed')
        .map((e) => (e.payload as { payload: unknown }).payload);
    const ignored = () =>
      MetricsRegistry.value('tenancy_provisioned_total', {
        outcome: 'verification_ignored',
      }) ?? 0;

    beforeAll(() => {
      verification = t.app.get(VerificationProjector);
    });

    it('follows the verification machine, publishes shop_verification_changed on change only, and payouts follow VERIFIED', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);

      await deliver(event('submitted', shop.id));
      expect(await state(shop.id)).toMatchObject({
        verificationStatus: 'PENDING',
        payoutsEnabled: false,
        shopVersion: '2',
      });
      await deliver(event('verified', shop.id));
      expect(await state(shop.id)).toMatchObject({
        verificationStatus: 'VERIFIED',
        payoutsEnabled: true,
        shopVersion: '3',
      });
      expect(await changed(shop.id)).toEqual([
        {
          shopId: shop.id,
          verificationStatus: 'PENDING',
          payoutsEnabled: false,
          shopVersion: 2,
        },
        {
          shopId: shop.id,
          verificationStatus: 'VERIFIED',
          payoutsEnabled: true,
          shopVersion: 3,
        },
      ]);

      // VERIFIED ignores everything after it: no change, no event
      const before = ignored();
      await deliver(event('rejected', shop.id));
      await deliver(event('submitted', shop.id));
      expect((await state(shop.id)).verificationStatus).toBe('VERIFIED');
      expect(await changed(shop.id)).toHaveLength(2);
      expect(ignored()).toBe(before + 2);
    });

    it('a rejection can be resubmitted', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      await deliver(event('submitted', shop.id));
      await deliver(event('rejected', shop.id));
      expect((await state(shop.id)).verificationStatus).toBe('REJECTED');
      await deliver(event('submitted', shop.id));
      expect((await state(shop.id)).verificationStatus).toBe('PENDING');
    });

    it('the same eventId twice is one change and one event', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const submitted = event('submitted', shop.id);
      await deliver(submitted);
      const counts = await deliver(submitted);
      expect(counts).toMatchObject({ duplicate: 1 });
      expect(await changed(shop.id)).toHaveLength(1);
      expect((await state(shop.id)).shopVersion).toBe('2');
    });

    it('verified arriving before submitted leaves the shop VERIFIED after the late submitted', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      await deliver(event('verified', shop.id));
      expect(await state(shop.id)).toMatchObject({
        verificationStatus: 'VERIFIED',
        payoutsEnabled: true,
      });
      await deliver(event('submitted', shop.id)); // late
      expect(await state(shop.id)).toMatchObject({
        verificationStatus: 'VERIFIED',
        payoutsEnabled: true,
      });
      expect(await changed(shop.id)).toHaveLength(1);
    });

    it('an unknown or DELETED shop is ignored and counted; unknown event types are skipped', async () => {
      const owner = await t.newUser();
      const gone = await createShop(t.app, owner, { status: 'DELETED' });
      const before = ignored();
      await deliver(event('submitted', uuidv7()));
      await deliver(event('submitted', gone.id));
      expect(ignored()).toBe(before + 2);
      expect((await state(gone.id)).verificationStatus).toBe('UNVERIFIED');
      expect(await changed(gone.id)).toHaveLength(0);
      await expect(
        verification.project([
          { ...event('submitted', gone.id), type: 'shop.something_else' },
        ]),
      ).resolves.toEqual({ applied: 0, duplicate: 0, stale: 0 });
    });

    it('an invalid payload is a permanent failure for the dead-letter topic and changes nothing', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      await expect(
        verification.project([
          { ...event('verified', shop.id), payload: { shopId: 5 } },
        ]),
      ).rejects.toBeInstanceOf(PermanentError);
      await expect(
        verification.project([{ ...event('verified', shop.id), payload: {} }]),
      ).rejects.toBeInstanceOf(PermanentError);
      expect((await state(shop.id)).verificationStatus).toBe('UNVERIFIED');
      expect(await changed(shop.id)).toHaveLength(0);
    });
  });
});
