import { Module } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { v4 } from 'uuid';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { AuthModule } from './auth.module';
import { AuthTestApp, createAuthApp } from './testing/auth-app';
import { ShopOwnerPromotionConsumer } from './infra/shop-owner-promotion.consumer';
import User, { Role } from './infra/models/user.model';

@Module({
  imports: [AuthModule],
  providers: [ShopOwnerPromotionConsumer],
  exports: [ShopOwnerPromotionConsumer],
})
class PromotionProbeModule {}

/** Follow-up left for S01 by S03: the owner of a new shop becomes a SELLER; tenancy no longer writes `User`. */
describe('S01 follow-up from S03: shop owner promotion', () => {
  let t: AuthTestApp;
  let consumer: ShopOwnerPromotionConsumer;

  const created = (ownerId: string | null): EventEnvelope => ({
    eventId: v4(),
    type: 'tenancy.shop_created',
    version: 1,
    aggregateType: 'tenancy',
    aggregateId: v4(),
    aggregateVersion: 1,
    occurredAt: new Date().toISOString(),
    payload: {
      shopId: v4(),
      ownerId,
      name: 'Shop',
      slug: 'shop',
      plan: 'FREE',
      region: 'EU',
      shopVersion: 1,
    },
  });
  const roleOf = async (id: string) =>
    (await t.app.get<typeof User>(getModelToken(User)).findByPk(id))?.role;

  beforeAll(async () => {
    t = await createAuthApp({ extraImports: [PromotionProbeModule] });
    consumer = t.app.get(ShopOwnerPromotionConsumer);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S03 follow-up: a USER owner becomes SELLER; redelivery changes nothing', async () => {
    const owner = await t.seedUser();
    const event = created(owner.id);
    await consumer.project([event]);
    expect(await roleOf(owner.id)).toBe('SELLER');
    await consumer.project([event]);
    expect(await roleOf(owner.id)).toBe('SELLER');
  });

  it.each(['SELLER', 'ADMIN', 'MODERATOR'])(
    'S03 follow-up: a %s owner is left unchanged',
    async (role) => {
      const owner = await t.seedUser({ role: role as Role });
      await consumer.project([created(owner.id)]);
      expect(await roleOf(owner.id)).toBe(role);
    },
  );

  it('S03 follow-up: unknown and null owners are ignored; an invalid payload is permanent', async () => {
    await consumer.project([created(v4()), created(null)]);
    const bad = created('x');
    (bad.payload as Record<string, unknown>).shopId = 5;
    await expect(consumer.project([bad])).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
});
