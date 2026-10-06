import { INestApplication, Module } from '@nestjs/common';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ShopModel as Shop } from '@app/domains/tenancy';
import Plan from './infra/models/plan.model';
import Price from './infra/models/price.model';
import Subscription from './infra/models/subscription.model';
import Invoice from './infra/models/invoice.model';
import { BillingModule, BILLING_MODELS } from './billing.module';
import { BillingService } from './application/billing.service';
import { BillingJobs, DUNNING_DAYS } from './infra/billing.jobs';
import { BillingGateway, FakeBillingGateway } from './infra/billing-gateway.port';
import { EntitlementsService } from './application/entitlements.service';
import { UsageService } from './application/usage.service';

@Module({
  imports: [EventsModule, SequelizeModule.forFeature(BILLING_MODELS)],
  providers: [{ provide: BillingGateway, useClass: FakeBillingGateway }, BillingJobs],
})
class BillingWorkerSpecModule {}

/** SD-24 against real Postgres + Redis (entitlements cache). Usage is stubbed at UsageService (ClickHouse covered by F-05 sink specs). */
describe('Subscription billing (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let billing: BillingService;
  let jobs: BillingJobs;
  let gateway: FakeBillingGateway;
  let shopId: string;
  let starter: Price;
  let pro: Price;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([BillingModule, BillingWorkerSpecModule, CacheModule, SeedsModule], { stores: ['redis'] });
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    billing = app.get(BillingService);
    jobs = app.get(BillingJobs);
    gateway = app.get(BillingGateway) as FakeBillingGateway;
    const prices = await app.get<typeof Price>(getModelToken(Price)).findAll({ include: [Plan] });
    starter = prices.find((p) => p.plan.code === 'starter')!;
    pro = prices.find((p) => p.plan.code === 'pro')!;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.get<typeof Invoice>(getModelToken(Invoice)).destroy({ where: {} });
    await app.get<typeof Subscription>(getModelToken(Subscription)).destroy({ where: {} });
    await seeds.clean();
    shopId = (await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'S', slug: `s-${v4().slice(0, 8)}` })).id;
    gateway.charges.length = 0;
    gateway.failuresLeft = 0;
    jest.spyOn(app.get(UsageService), 'totalFor').mockResolvedValue(0);
    jest.spyOn(app.get(UsageService), 'lateFor').mockResolvedValue(0);
  });

  const expire = (id: string) =>
    app.get<typeof Subscription>(getModelToken(Subscription)).update({ currentPeriodEnd: new Date(Date.now() - 1_000) }, { where: { id } });

  it('subscribe → first invoice charged; entitlements switch from free to the plan', async () => {
    expect((await app.get(EntitlementsService).get('SHOP', shopId)).auctions).toBe(false);
    const sub = await billing.subscribe({ subjectType: 'SHOP', subjectId: shopId, priceId: pro.id, quantity: 3, paymentMethodRef: 'pm_visa' });

    const [invoice] = await billing.invoices(sub.id);
    expect(Number(invoice.total)).toBe(9900 * 3);
    await jobs.charge({ invoiceId: invoice.id });
    expect((await invoice.reload()).status).toBe('PAID');
    expect((await app.get(EntitlementsService).get('SHOP', shopId)).auctions).toBe(true);
  });

  it('renewal run is idempotent: two runs → one renewal invoice, period advanced once', async () => {
    const sub = await billing.subscribe({ subjectType: 'SHOP', subjectId: shopId, priceId: starter.id, paymentMethodRef: 'pm_visa' });
    await expire(sub.id);

    await Promise.all([jobs.run(), jobs.run()]);

    const renewals = (await billing.invoices(sub.id)).filter((i) => i.kind === 'RENEWAL');
    expect(renewals).toHaveLength(2); // initial + one renewal
    expect((await sub.reload()).version).toBe(1);
  });

  it('dunning: retries on day 1/3/7, then UNPAID and entitlements drop to free', async () => {
    const sub = await billing.subscribe({ subjectType: 'SHOP', subjectId: shopId, priceId: pro.id, paymentMethodRef: 'pm_declined' });
    const [invoice] = await billing.invoices(sub.id);
    gateway.failuresLeft = DUNNING_DAYS.length + 1;

    for (let i = 0; i <= DUNNING_DAYS.length; i++) await jobs.charge({ invoiceId: invoice.id });

    expect((await invoice.reload()).status).toBe('UNCOLLECTIBLE');
    expect((await sub.reload()).status).toBe('UNPAID');
    expect((await app.get(EntitlementsService).get('SHOP', shopId)).auctions).toBe(false);
    expect(new Set(gateway.charges.map((c) => c.idempotencyKey)).size).toBe(DUNNING_DAYS.length + 1); // distinct key per attempt
  });

  it('upgrade mid-cycle: the proration invoice equals the preview', async () => {
    const sub = await billing.subscribe({ subjectType: 'SHOP', subjectId: shopId, priceId: starter.id, paymentMethodRef: 'pm_visa' });
    const preview = await billing.previewChange(sub.id, { priceId: pro.id });
    await billing.change(sub.id, { priceId: pro.id });

    const proration = (await billing.invoices(sub.id)).find((i) => i.kind === 'PRORATION')!;
    expect(Number(proration.total)).toBe(preview.reduce((s, l) => s + l.amount, 0));
  });

  it('cancel at period end: access until the end, CANCELED at renewal, no new invoice', async () => {
    const sub = await billing.subscribe({ subjectType: 'SHOP', subjectId: shopId, priceId: pro.id, paymentMethodRef: 'pm_visa' });
    await billing.cancelAtPeriodEnd(sub.id);
    expect((await app.get(EntitlementsService).get('SHOP', shopId)).auctions).toBe(true);

    await expire(sub.id);
    await jobs.run();

    expect((await sub.reload()).status).toBe('CANCELED');
    expect(await billing.invoices(sub.id)).toHaveLength(1);
  });
});
