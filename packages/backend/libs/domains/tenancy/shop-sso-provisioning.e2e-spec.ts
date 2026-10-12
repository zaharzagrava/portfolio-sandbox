import { Module } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { TransactionRunner } from '@app/infrastructure/context';
import { InboxModule, InboxService } from '@app/infrastructure/inbox';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { FederatedIdentityLinked } from '@app/domains/identity';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { ShopMembershipModel } from './index';
import { SsoProvisioningProjector } from './infra/projectors/sso-provisioning.projector';
import { TenancyPlanStateModule } from './tenancy-worker.module';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

@Module({
  imports: [TenancyPlanStateModule, InboxModule],
  providers: [SsoProvisioningProjector],
  exports: [SsoProvisioningProjector],
})
class ProvisioningProbeModule {}

describe('Membership provisioning from company sign-in', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;
  let projector: SsoProvisioningProjector;

  const linked = (
    userId: string,
    provider: string,
    eventId = v4(),
  ): EventEnvelope => ({
    ...FederatedIdentityLinked.create(userId, 1, {
      userId,
      provider,
      linkMethod: 'login',
      passwordInvalidated: false,
      mfaReset: false,
    }),
    eventId,
  });
  /** What the projection framework does for `idempotency: 'inbox'`: record `(consumer, eventId)` in the effect's transaction. */
  const deliver = (event: EventEnvelope) =>
    t.app.get(TransactionRunner).run(async () => {
      if (
        await t.app.get(InboxService).recordOnce(projector.name, event.eventId)
      )
        return projector.project([event]);
      return { applied: 0, duplicate: 1, stale: 0 };
    });
  const configure = (shopId: string, enabled = true, defaultRole = 'STAFF') =>
    sequelize.query(
      `INSERT INTO "ShopSsoConfig" ("shopId","issuer","clientId","clientSecretEnc","defaultRole","enabled","updatedAt")
       VALUES ($1,'https://idp.example.com','client','sealed',$2,$3,now())`,
      { bind: [shopId, defaultRole, enabled] },
    );
  const memberships = (shopId: string, userId: string) =>
    t.app
      .get<typeof ShopMembershipModel>(getModelToken(ShopMembershipModel))
      .findAll({ where: { shopId, userId }, raw: true });
  const added = async (shopId: string) =>
    (await outboxRowsFor(sequelize, shopId)).filter(
      (e) => e.type === 'tenancy.member_added',
    );
  const counter = (outcome: string) =>
    MetricsRegistry.value('tenancy_provisioned_total', { outcome }) ?? 0;

  beforeAll(async () => {
    t = await createTenancyApp({ extraImports: [ProvisioningProbeModule] });
    sequelize = t.app.get(Sequelize);
    projector = t.app.get(SsoProvisioningProjector);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S03 AS-47: the first sign-in through the shop provider adds the user with the default role; duplicates and later events change nothing', async () => {
    const owner = await t.newUser();
    const worker = await t.newUser();
    const shop = await createShop(t.app, owner);
    await configure(shop.id, true, 'STAFF');
    const event = linked(worker.id, `shop:${shop.id}`);

    await deliver(event);
    const [row] = await memberships(shop.id, worker.id);
    expect(row).toMatchObject({ role: 'STAFF', source: 'sso' });
    const events = await added(shop.id);
    expect(events).toHaveLength(1);
    expect((events[0].payload as { payload: object }).payload).toEqual({
      shopId: shop.id,
      userId: worker.id,
      role: 'STAFF',
      source: 'sso',
    });

    await deliver(event); // the same delivery again: the inbox refuses it
    expect(await memberships(shop.id, worker.id)).toHaveLength(1);
    expect(await added(shop.id)).toHaveLength(events.length);

    await sequelize.query(
      `UPDATE "ShopMembership" SET "role" = 'ADMIN' WHERE "shopId" = $1 AND "userId" = $2`,
      { bind: [shop.id, worker.id] },
    );
    await deliver(linked(worker.id, `shop:${shop.id}`)); // a second sign-in: a new event
    const [after] = await memberships(shop.id, worker.id);
    expect(after.role).toBe('ADMIN');
    expect(await added(shop.id)).toHaveLength(events.length);
  });

  it('S03 AS-48: other providers are ignored; a disabled provider, a closed shop and a full team are denied, each counted by reason', async () => {
    const owner = await t.newUser();
    const worker = await t.newUser();
    const shop = await createShop(t.app, owner);
    const ignored = counter('sso_ignored');

    await deliver(linked(worker.id, 'google'));
    await deliver(linked(worker.id, 'shop:not-a-uuid'));
    await deliver(linked(worker.id, `shop:${v4()}`)); // unknown shop
    expect(counter('sso_ignored')).toBe(ignored + 3);

    // No configuration, then a disabled one.
    const noConfig = counter('sso_denied_not_enabled');
    await deliver(linked(worker.id, `shop:${shop.id}`));
    await configure(shop.id, false);
    await deliver(linked(worker.id, `shop:${shop.id}`));
    expect(counter('sso_denied_not_enabled')).toBe(noConfig + 2);
    await sequelize.query(
      `UPDATE "ShopSsoConfig" SET "enabled" = true WHERE "shopId" = $1`,
      { bind: [shop.id] },
    );

    // Shop not active.
    const closed = counter('sso_denied_status');
    await sequelize.query(
      `UPDATE "Shop" SET "status" = 'SUSPENDED' WHERE "id" = $1`,
      { bind: [shop.id] },
    );
    await deliver(linked(worker.id, `shop:${shop.id}`));
    expect(counter('sso_denied_status')).toBe(closed + 1);
    await sequelize.query(
      `UPDATE "Shop" SET "status" = 'ACTIVE' WHERE "id" = $1`,
      { bind: [shop.id] },
    );

    // STARTER has five seats: the owner plus four more fill it.
    for (let i = 0; i < 4; i++)
      await addMember(t.app, shop.id, (await t.newUser()).id, 'VIEWER');
    const full = counter('sso_denied_seats');
    await deliver(linked(worker.id, `shop:${shop.id}`));
    expect(counter('sso_denied_seats')).toBe(full + 1);

    expect(await memberships(shop.id, worker.id)).toHaveLength(0);
    expect(await added(shop.id)).toHaveLength(0);

    await expect(
      projector.project([
        {
          ...linked(worker.id, `shop:${shop.id}`),
          payload: { userId: 5 },
        },
      ]),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(await memberships(shop.id, worker.id)).toHaveLength(0);
  });

  it('S03 AS-49: a redelivery after the member was removed does not add them again', async () => {
    const owner = await t.newUser();
    const worker = await t.newUser();
    const shop = await createShop(t.app, owner);
    await configure(shop.id);
    const event = linked(worker.id, `shop:${shop.id}`);
    await deliver(event);
    expect(await memberships(shop.id, worker.id)).toHaveLength(1);

    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/members/${worker.id}`)
      .expect(204);
    expect(await memberships(shop.id, worker.id)).toHaveLength(0);

    await deliver(event);
    expect(await memberships(shop.id, worker.id)).toHaveLength(0);
    const [{ n }] = await sequelize.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "ProcessedWebhookEvent" WHERE "provider" = $1 AND "eventId" = $2`,
      { bind: [projector.name, event.eventId], type: QueryTypes.SELECT },
    );
    expect(n).toBe('1'); // kept for the inbox retention (30 days), which is the topic's retention
  });
});
