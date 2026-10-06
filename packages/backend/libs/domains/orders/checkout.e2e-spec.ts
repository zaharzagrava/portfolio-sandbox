import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { getModelToken } from '@nestjs/sequelize';
import { v4 } from 'uuid';
import Stripe from 'stripe';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { AuthService, UserModel as User } from '@app/domains/identity';
import { ProductModel as Product } from '@app/domains/catalog';
import BisOrder from './infra/models/bis-order.model';
import { PaymentModel as Payment, PaymentStatus } from '@app/domains/payments';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { OrdersModule } from './orders.module';
import { CheckoutService } from './application/checkout.service';
import { CartRepository } from './infra/cart.repository';
import { CartIdentity } from './api/cart-identity';
import { FlashStockService } from './infra/flash-stock.service';
import { OrderService } from './application/order.service';

/** SD-19 against real Postgres + Redis + DynamoDB Local. */
describe('Checkout & inventory (e2e)', () => {
  let app: INestApplication;
  let seedsService: SeedsService;
  let checkout: CheckoutService;
  let carts: CartRepository;
  let flash: FlashStockService;
  let orders: OrderService;
  let productModel: typeof Product;
  let orderModel: typeof BisOrder;
  let userModel: typeof User;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([OrdersModule, RateLimitModule, CacheModule, SeedsModule], { stores: ['redis', 'dynamo'] });
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    await app.init();
    seedsService = app.get(SeedsService);
    checkout = app.get(CheckoutService);
    carts = app.get(CartRepository);
    flash = app.get(FlashStockService);
    orders = app.get(OrderService);
    productModel = app.get(getModelToken(Product));
    orderModel = app.get(getModelToken(BisOrder));
    userModel = app.get(getModelToken(User));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedsService.clean();
  });

  const buyers = async (n: number) =>
    userModel.bulkCreate(Array.from({ length: n }, () => ({ email: `b-${v4()}@mail.com` })), { returning: true });

  const fillCarts = (users: User[], productId: string, quantity = 1) =>
    Promise.all(users.map((u) => carts.setLine(CartIdentity.userCartId(u.id), productId, quantity)));

  it('200 buyers race for 50 units → exactly 50 RESERVED orders, stock never negative', async () => {
    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, quantity: 50, price: 99_00 }]);
    const users = await buyers(200);
    await fillCarts(users, product.id);

    const results = await inParallel(200, (i) => checkout.checkout(users[i].id, CartIdentity.userCartId(users[i].id), `key-${v4()}`));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(50);
    expect((await productModel.findByPk(product.id))!.quantity).toBe(0);
    expect(await orderModel.count({ where: { status: 'RESERVED' } })).toBe(50);
  });

  it('flash sale: 100 buyers on 30 Redis-bucketed units → 30 orders, buckets drained, Postgres row untouched', async () => {
    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, quantity: 5, price: 999_00 }]);
    const saleId = v4();
    await flash.load({ saleId, productId: product.id, price: 499_00, buckets: 8, perUserLimit: 1, endsAt: new Date(Date.now() + 3_600_000).toISOString(), units: 30 });
    const users = await buyers(100);
    await fillCarts(users, product.id);

    const results = await inParallel(100, (i) => checkout.checkout(users[i].id, CartIdentity.userCartId(users[i].id), `key-${v4()}`));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(30);
    expect(await flash.remaining(saleId, 8)).toBe(0);
    expect((await productModel.findByPk(product.id))!.quantity).toBe(5); // regular stock unaffected
    const order = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ total: number }>).value;
    expect(order.total).toBe(499_00); // drop price, server-side
  });

  it('flash sale per-customer limit', async () => {
    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, quantity: 0 }]);
    const saleId = v4();
    await flash.load({ saleId, productId: product.id, price: 100, buckets: 2, perUserLimit: 1, endsAt: new Date(Date.now() + 3_600_000).toISOString(), units: 10 });
    const [user] = await buyers(1);
    await fillCarts([user], product.id, 2);

    await expect(checkout.checkout(user.id, CartIdentity.userCartId(user.id), `key-${v4()}`)).rejects.toThrow(/Limit of 1/);
    expect(await flash.remaining(saleId, 2)).toBe(10);
  });

  it('Idempotency-Key: concurrent retries of one checkout create one order', async () => {
    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, quantity: 10 }]);
    const [user] = await buyers(1);
    await fillCarts([user], product.id);
    const token = app.get(AuthService).issueTokensFor(user).accessToken.token;

    const responses = await inParallel(5, () =>
      request(app.getHttpServer()).post('/api/checkout').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'same-key-123'),
    );
    const ids = new Set(responses.map((r) => (r as PromiseFulfilledResult<request.Response>).value.body.orderId).filter(Boolean));
    expect(ids.size).toBe(1);
    expect(await orderModel.count({ where: { userId: user.id } })).toBe(1);
    expect((await productModel.findByPk(product.id))!.quantity).toBe(9);
  });

  it('saga: paid twice (Kafka + webhook) → one transition; hold expiry after payment is a no-op; unpaid expiry restores stock', async () => {
    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, quantity: 3 }]);
    const [a, b] = await buyers(2);
    await fillCarts([a, b], product.id);
    const paid = await checkout.checkout(a.id, CartIdentity.userCartId(a.id), `key-${v4()}`);
    const unpaid = await checkout.checkout(b.id, CartIdentity.userCartId(b.id), `key-${v4()}`);

    const results = await inParallel(2, () => orders.markPaid(paid.orderId, 'pay_1'));
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === true)).toHaveLength(1);
    expect(await orders.cancel(paid.orderId, 'hold_expired').catch((e) => e.status)).toBe(409);

    await orders.cancel(unpaid.orderId, 'hold_expired');
    expect((await productModel.findByPk(product.id))!.quantity).toBe(2);
    expect((await orderModel.findByPk(unpaid.orderId))!.status).toBe('CANCELLED');

    const events = await app.get<typeof Outbox>(getModelToken(Outbox)).findAll({ where: { aggregateId: paid.orderId } });
    expect(events.map((e) => e.eventName).sort()).toEqual(['order.paid', 'order.reserved']);
  });

  it('Stripe webhook: valid signature marks paid once; duplicate delivery is ignored; bad signature rejected', async () => {
    const secret = 'whsec_test_secret';
    (app.get(ApiConfigService) as MockApiConfigService).set('stripe_webhook_secret', secret);
    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, quantity: 1 }]);
    const [user] = await buyers(1);
    await fillCarts([user], product.id);
    const order = await checkout.checkout(user.id, CartIdentity.userCartId(user.id), `key-${v4()}`);
    await app.get<typeof Payment>(getModelToken(Payment)).create({
      idempotencyKey: order.orderId,
      amount: order.total,
      status: PaymentStatus.PENDING,
      userId: user.id,
      bisOrderId: order.orderId,
    });

    const payload = JSON.stringify({
      id: `evt_${v4()}`,
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', metadata: { idempotencyKey: order.orderId } } },
    });
    const signature = new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({ payload, secret });
    const send = (sig: string) =>
      request(app.getHttpServer()).post('/api/webhooks/stripe').set('stripe-signature', sig).set('Content-Type', 'application/json').send(payload);

    await send(signature).expect(200);
    expect((await send(signature).expect(200)).body.duplicate).toBe(true);
    expect((await orderModel.findByPk(order.orderId))!.status).toBe('PAID');
    await send('t=1,v1=forged').expect(400);
  });
});
