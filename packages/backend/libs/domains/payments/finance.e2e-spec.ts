import { INestApplication, Module } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  SequelizeModule,
} from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v4, v7 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { LedgerModule } from './ledger.module';
import { LedgerService } from './application/ledger.service';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { PAYMENTS_AGGREGATE } from './application/events/payment-events';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import {
  LEDGER_ACCOUNTS,
  PLATFORM_FEE_MINOR,
  shopAccount,
} from './domain/accounts';
import Payout from './infra/models/payout.model';
import { ShopModel as Shop } from '@app/domains/tenancy';
import Payment, { PaymentStatus } from './infra/models/payment.model';
import { OrderPaid } from '@app/domains/orders';
import {
  FakePayoutProvider,
  PayoutProvider,
} from './infra/payout-provider.port';
import { PayoutJobs } from './infra/payout.jobs';
import { ReconciliationJobs } from './infra/reconciliation.jobs';
import { SettlementListener } from './infra/settlement.listener';
import { seedPayment } from './testing';

@Module({
  imports: [
    LedgerModule,
    StripeModule,
    EventsModule.forAggregates([PAYMENTS_AGGREGATE]),
    JobsModule,
    SequelizeModule.forFeature([Payout, Shop, Payment]),
  ],
  providers: [
    { provide: PayoutProvider, useClass: FakePayoutProvider },
    PayoutJobs,
    ReconciliationJobs,
    SettlementListener,
  ],
})
class FinanceSpecModule {}

/** SD-20 against the real test Postgres (partitioned ledger + constraint trigger). */
describe('Ledger, settlement, payouts, reconciliation (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let ledger: LedgerService;
  let sequelize: Sequelize;
  let provider: FakePayoutProvider;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([
      FinanceSpecModule,
      SeedsModule,
    ]);
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    ledger = app.get(LedgerService);
    sequelize = app.get(getConnectionToken());
    provider = app.get(PayoutProvider) as FakePayoutProvider;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await sequelize.query(
      `TRUNCATE "LedgerEntry", "Payout", "ReconciliationRun", "ReconciliationIssue" CASCADE`,
    );
    await seeds.clean();
  });

  const shop = () =>
    app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'S', slug: `s-${v4().slice(0, 8)}` });
  const balance = (account: string) => ledger.balance(account);

  it('the database itself rejects an unbalanced journal at COMMIT (deferred constraint trigger)', async () => {
    const journalId = v7();
    await expect(
      sequelize.transaction(async (transaction) => {
        await sequelize.query(
          `INSERT INTO "LedgerEntry" ("journalId", kind, "accountId", amount) VALUES (:j, 'ADJUSTMENT', 'A', 100), (:j, 'ADJUSTMENT', 'B', -99)`,
          { replacements: { j: journalId }, transaction },
        );
      }),
    ).rejects.toThrow(/unbalanced ledger journal/);
    expect(await balance('A')).toBe(0);
  });

  it('settlement splits the net amount across shops to the cent, exactly once on redelivery', async () => {
    const [a, b, c] = [await shop(), await shop(), await shop()];
    // Fund clearing as a sale would.
    await sequelize.transaction((tx) =>
      ledger.post(
        {
          journalId: v7(),
          kind: 'ADJUSTMENT',
          lines: [
            { accountId: 'EXTERNAL', amount: -1000 },
            { accountId: LEDGER_ACCOUNTS.CLEARING, amount: 1000 },
          ],
        },
        tx,
      ),
    );

    const orderId = v7();
    const event = OrderPaid.create(orderId, 3, {
      orderId,
      userId: v4(),
      orderVersion: 3,
      totalMinor: 1000 + PLATFORM_FEE_MINOR,
      currency: 'usd',
      paymentRef: 'pay_spec',
      paidAt: new Date().toISOString(),
      lines: [a, b, c].map((s) => ({
        productId: v4(),
        shopId: s.id,
        title: 'Item',
        quantity: 1,
        unitPriceMinor: 350,
        discountMinor: 0,
        lineTotalMinor: 350,
      })),
      shopOrders: [],
    });
    const listener = app.get(SettlementListener);
    await listener.project([event]);
    await listener.project([event]); // redelivery

    const shares = await Promise.all(
      [a, b, c].map((s) => balance(shopAccount(s.id))),
    );
    expect(shares).toEqual([334, 333, 333]);
    expect(await balance(LEDGER_ACCOUNTS.CLEARING)).toBe(0);
  });

  it('weekly payouts: one per shop per week; success moves money out, failure reverses it', async () => {
    const [ok, broken] = [await shop(), await shop()];
    await ok.update({ stripeAccountId: 'acct_ok' });
    for (const s of [ok, broken]) {
      await sequelize.transaction((tx) =>
        ledger.post(
          {
            journalId: v7(),
            kind: 'ADJUSTMENT',
            lines: [
              { accountId: LEDGER_ACCOUNTS.CLEARING, amount: -5000 },
              { accountId: shopAccount(s.id), amount: 5000 },
            ],
          },
          tx,
        ),
      );
    }

    const jobs = app.get(PayoutJobs);
    await jobs.run({ periodStart: '2026-09-28' });
    await jobs.run({ periodStart: '2026-09-28' }); // idempotent re-run
    const payouts = await app
      .get<typeof Payout>(getModelToken(Payout))
      .findAll();
    expect(payouts).toHaveLength(2);

    for (const p of payouts) await jobs.send({ payoutId: p.id });

    expect(provider.transfers).toEqual([
      expect.objectContaining({ amount: 5000, destination: 'acct_ok' }),
    ]);
    expect(await balance(shopAccount(ok.id))).toBe(0);
    expect(await balance('PAYOUTS_SENT')).toBe(5000);
    expect(await balance(shopAccount(broken.id))).toBe(5000); // reversed: no payout account
    expect(await balance(LEDGER_ACCOUNTS.PAYOUT_CLEARING)).toBe(0);
  });

  it('a captured payment is booked once through the payment wrappers and a refund reverses it exactly', async () => {
    const [user] = await seeds.createTreelike([
      { __type__: TableName.User, email: `u-${v4()}@mail.com` },
    ]);
    const { id: paymentId } = await seedPayment(app, {
      userId: user.id,
      amountMinor: 2000,
      createdAt: new Date(),
    });
    const payment = {
      paymentId,
      userId: user.id,
      amountMinor: 2000,
      currency: 'EUR',
    };
    const book = (fn: 'recordPaymentCaptured' | 'recordPaymentRefunded') =>
      sequelize.transaction((tx) => ledger[fn](payment, tx));

    const first = await book('recordPaymentCaptured');
    const replay = await book('recordPaymentCaptured'); // redelivery posts nothing new

    expect(replay.journalId).toBe(first.journalId);
    expect(await balance(LEDGER_ACCOUNTS.PROVIDER_FUNDS)).toBe(-2000);
    expect(await balance(LEDGER_ACCOUNTS.CLEARING)).toBe(
      2000 - PLATFORM_FEE_MINOR,
    );
    expect(await balance(LEDGER_ACCOUNTS.PLATFORM_FEES)).toBe(
      PLATFORM_FEE_MINOR,
    );

    await book('recordPaymentRefunded');
    await book('recordPaymentRefunded');

    expect(await balance(LEDGER_ACCOUNTS.PROVIDER_FUNDS)).toBe(0);
    expect(await balance(LEDGER_ACCOUNTS.CLEARING)).toBe(0);
    expect(await balance(LEDGER_ACCOUNTS.PLATFORM_FEES)).toBe(0);
  });

  it('daily reconciliation flags missing-in-ledger, missing-at-provider and amount mismatches', async () => {
    const [user] = await seeds.createTreelike([
      { __type__: TableName.User, email: `u-${v4()}@mail.com` },
    ]);
    const [order] = await seeds.createTreelike([
      { __type__: TableName.BisOrder, userId: user.id },
    ]);
    const payments = app.get<typeof Payment>(getModelToken(Payment));
    const base = {
      userId: user.id,
      bisOrderId: order.id,
      status: PaymentStatus.COMPLETED,
    };
    await payments.bulkCreate([
      { ...base, idempotencyKey: 'match', amount: 100 },
      { ...base, idempotencyKey: 'wrong-amount', amount: 100 },
      { ...base, idempotencyKey: 'ours-only', amount: 100 },
    ]);
    const day = new Date().toISOString().slice(0, 10);
    jest
      .spyOn(app.get(StripeService), 'paymentIntentsCreatedBetween')
      .mockImplementation(async function* () {
        yield {
          id: 'pi_1',
          status: 'succeeded',
          amount: 100,
          metadata: { idempotencyKey: 'match' },
        } as never;
        yield {
          id: 'pi_2',
          status: 'succeeded',
          amount: 150,
          metadata: { idempotencyKey: 'wrong-amount' },
        } as never;
        yield {
          id: 'pi_3',
          status: 'succeeded',
          amount: 100,
          metadata: { idempotencyKey: 'stripe-only' },
        } as never;
      });

    await app.get(ReconciliationJobs).reconcile({ day });

    const issues = await sequelize.query<{ kind: string; reference: string }>(
      `SELECT kind, reference FROM "ReconciliationIssue" ORDER BY reference`,
      {
        type: 'SELECT' as never,
      },
    );
    expect(issues).toEqual([
      { kind: 'MISSING_AT_PROVIDER', reference: 'ours-only' },
      { kind: 'MISSING_IN_LEDGER', reference: 'stripe-only' },
      { kind: 'AMOUNT_MISMATCH', reference: 'wrong-amount' },
    ]);
  });
});
