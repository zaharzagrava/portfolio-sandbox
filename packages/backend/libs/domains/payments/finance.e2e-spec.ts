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
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import {
  LEDGER_ACCOUNTS,
  PLATFORM_FEE_MINOR,
  shopAccount,
} from './domain/accounts';
import Payout from './infra/models/payout.model';
import { ShopModel as Shop } from '@app/domains/tenancy';
import Payment, { PaymentStatus } from './infra/models/payment.model';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { OrderPaid } from '@app/domains/orders';
import {
  FakePayoutProvider,
  PayoutProvider,
} from './infra/payout-provider.port';
import { PayoutJobs } from './infra/payout.jobs';
import { PaymentResolutionJobs } from './infra/payment-resolution.jobs';
import { ReconciliationJobs } from './infra/reconciliation.jobs';
import { SettlementListener } from './infra/settlement.listener';

@Module({
  imports: [
    LedgerModule,
    StripeModule,
    OutboxModule,
    JobsModule,
    SequelizeModule.forFeature([Payout, Shop, Payment]),
  ],
  providers: [
    { provide: PayoutProvider, useClass: FakePayoutProvider },
    PayoutJobs,
    PaymentResolutionJobs,
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
      userId: v4(),
      total: 1000 + PLATFORM_FEE_MINOR,
      paymentId: 'pay_spec',
      lines: [a, b, c].map((s) => ({
        productId: v4(),
        shopId: s.id,
        quantity: 1,
        price: 350,
      })),
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

  it('UNKNOWN payment is resolved by asking Stripe (never re-charging) and settled through ledger + outbox', async () => {
    const [user] = await seeds.createTreelike([
      { __type__: TableName.User, email: `u-${v4()}@mail.com` },
    ]);
    const [order] = await seeds.createTreelike([
      { __type__: TableName.BisOrder, userId: user.id },
    ]);
    const payment = await app
      .get<typeof Payment>(getModelToken(Payment))
      .create({
        idempotencyKey: v4(),
        amount: 2000,
        status: PaymentStatus.UNKNOWN,
        userId: user.id,
        bisOrderId: order.id,
      });
    await sequelize.query(
      `UPDATE "Payment" SET "updatedAt" = now() - interval '10 minutes', "createdAt" = now() - interval '10 minutes' WHERE id = :id`,
      {
        replacements: { id: payment.id },
      },
    );
    const stripe = app.get(StripeService);
    jest
      .spyOn(stripe, 'findPaymentIntentByIdempotencyKey')
      .mockResolvedValue({ id: 'pi_found', status: 'succeeded' } as never);
    const create = jest.spyOn(stripe, 'createPaymentIntent');

    await app.get(PaymentResolutionJobs).resolve();

    expect((await payment.reload()).status).toBe(PaymentStatus.COMPLETED);
    expect(payment.providerRef).toBe('pi_found');
    expect(create).not.toHaveBeenCalled();
    expect(await balance(LEDGER_ACCOUNTS.CLEARING)).toBe(
      2000 - PLATFORM_FEE_MINOR,
    );
    expect(
      await app
        .get<typeof Outbox>(getModelToken(Outbox))
        .count({ where: { topic: 'payments.responses' } }),
    ).toBe(1);
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
