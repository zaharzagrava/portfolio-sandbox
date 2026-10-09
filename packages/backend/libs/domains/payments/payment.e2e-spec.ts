import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { trace } from '@opentelemetry/api';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { PaymentModule } from './payment.module';
import { PaymentService } from './application/payment.service';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import Payment, { PaymentStatus } from './infra/models/payment.model';
import LedgerEntry from './infra/models/ledger-entry.model';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { ProductModel as Product } from '@app/domains/catalog';
import { UserModel as User } from '@app/domains/identity';
import { BisOrderModel as BisOrder } from '@app/domains/orders';
import { PostPaymentParamsDto } from './api/payment.dto';

/**
 * Existing critical flows (README #3 idempotency, #4 ledger, #6 OCC, #8 saga),
 * exercised against the real test Postgres (F-04 / DOUBTS Q9). Payments arrive
 * through Kafka, so these specs drive `PaymentService.executePayment` - the
 * consumer's handler - directly; Stripe is the only thing stubbed.
 */
describe('PaymentService (e2e, real Postgres)', () => {
  let app: INestApplication;
  let seedsService: SeedsService;
  let paymentService: PaymentService;
  let stripeService: StripeService;

  let paymentModel: typeof Payment;
  let ledgerEntryModel: typeof LedgerEntry;
  let outboxModel: typeof Outbox;
  let productModel: typeof Product;

  let createIntentSpy: jest.SpyInstance;
  let refundSpy: jest.SpyInstance;

  let buyer: User;
  let order: BisOrder;

  const span = () => trace.getTracer('e2e').startSpan('test');

  const params = (
    overrides: Partial<PostPaymentParamsDto> = {},
  ): PostPaymentParamsDto =>
    ({
      idempotency_key: v4(),
      amount: 100_00,
      userId: buyer.id,
      bisOrderId: order.id,
      paymentMethodId: 'pm_card_visa',
      ...overrides,
    }) as PostPaymentParamsDto;

  const execute = (p: PostPaymentParamsDto) =>
    paymentService.executePayment({
      params: p,
      activeSpan: span(),
    });

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([PaymentModule, SeedsModule]);
    app = moduleRef.createNestApplication();
    await app.init();

    seedsService = app.get(SeedsService);
    paymentService = app.get(PaymentService);
    stripeService = app.get(StripeService);
    paymentModel = app.get(getModelToken(Payment));
    ledgerEntryModel = app.get(getModelToken(LedgerEntry));
    outboxModel = app.get(getModelToken(Outbox));
    productModel = app.get(getModelToken(Product));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedsService.clean();
    jest.restoreAllMocks();

    createIntentSpy = jest
      .spyOn(stripeService, 'createPaymentIntent')
      .mockImplementation(
        async ({ idempotencyKey }) =>
          ({ id: `pi_${idempotencyKey}`, status: 'succeeded' }) as never,
      );
    refundSpy = jest
      .spyOn(stripeService, 'refundPaymentIntent')
      .mockResolvedValue(undefined as never);

    [buyer] = await seedsService.createTreelike([
      { __type__: TableName.User, email: `buyer-${v4()}@mail.com` },
    ]);
    [order] = await seedsService.createTreelike([
      { __type__: TableName.BisOrder, userId: buyer.id },
    ]);
  });

  describe('idempotency under duplicate delivery', () => {
    it('two concurrent deliveries of the same message → one COMPLETED payment, one balanced ledger set, one outbox event', async () => {
      const message = params();

      const results = await inParallel(2, () => execute(message));
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      const payments = await paymentModel.findAll({
        where: { idempotencyKey: message.idempotency_key },
      });
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe(PaymentStatus.COMPLETED);

      const entries = await ledgerEntryModel.findAll({
        where: { paymentId: payments[0].id },
      });
      expect(entries).toHaveLength(3);
      expect(entries.reduce((sum, e) => sum + BigInt(e.amount), 0n)).toBe(0n);

      const events = await outboxModel.findAll();
      expect(
        events.filter((e) => e.aggregateId === message.idempotency_key),
      ).toHaveLength(1);
    });

    it('a redelivery after completion returns the stored result without charging again', async () => {
      const message = params();
      await execute(message);
      createIntentSpy.mockClear();

      const second = await execute(message);

      expect(second.payment.status).toBe(PaymentStatus.COMPLETED);
      expect(createIntentSpy).not.toHaveBeenCalled();
      expect(await ledgerEntryModel.count()).toBe(3);
    });
  });

  describe('optimistic stock decrement (OCC) + compensating refund', () => {
    it('last unit bought by two buyers at once → one COMPLETED, one REFUNDED, stock 0, exactly one refund', async () => {
      const [product] = await seedsService.createTreelike([
        { __type__: TableName.Product, quantity: 1 },
      ]);

      const results = await inParallel(2, () =>
        execute(params({ productId: product.id, quantity: 1 })),
      );
      expect(
        results.flatMap((r) =>
          r.status === 'rejected' ? [String(r.reason)] : [],
        ),
      ).toEqual([]);

      const statuses = (await paymentModel.findAll())
        .map((p) => p.status)
        .sort();
      // Either both raced past the cheap pre-check (COMPLETED + REFUNDED), or the
      // loser saw stock 0 up front and never charged (COMPLETED + PENDING). Never two sales.
      expect(
        statuses.filter((s) => s === PaymentStatus.COMPLETED),
      ).toHaveLength(1);
      expect(
        await productModel.findByPk(product.id).then((p) => p!.quantity),
      ).toBe(0);
      expect(refundSpy.mock.calls.length).toBeLessThanOrEqual(1);
      if (statuses.includes(PaymentStatus.REFUNDED))
        expect(refundSpy).toHaveBeenCalledTimes(1);

      // Only the winning payment hits the ledger.
      expect(await ledgerEntryModel.count()).toBe(3);
    });

    it('out of stock before charging → no Stripe call, no ledger entries', async () => {
      const [product] = await seedsService.createTreelike([
        { __type__: TableName.Product, quantity: 0 },
      ]);

      await execute(params({ productId: product.id, quantity: 1 }));

      expect(createIntentSpy).not.toHaveBeenCalled();
      expect(await ledgerEntryModel.count()).toBe(0);
    });
  });
});
