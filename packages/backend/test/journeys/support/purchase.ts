import {
  balanceSchema,
  checkoutResponseSchema,
  orderSchema,
  paymentAcceptedSchema,
  paymentSchema,
  type Balance,
  type CheckoutResponse,
  type OrderDto,
  type PaymentView,
} from '@marketplace-sandbox/contracts';
import { randomUUID } from 'node:crypto';
import { JourneyClient } from './journey-client';
import type { FixtureProduct, SellerFixture } from './seller-fixture';
import { waitForContract } from './wait-for-contract';

export interface CartLine {
  product: FixtureProduct;
  quantity: number;
}

export interface Purchase {
  order: CheckoutResponse;
  checkoutKey: string;
}

/** Puts the lines in the buyer's cart and checks out with the given key (default: a fresh one). */
export async function checkout(
  buyer: JourneyClient,
  lines: CartLine[],
  key: string = randomUUID(),
): Promise<Purchase> {
  for (const line of lines) {
    const put = await buyer.put(`/api/cart/items/${line.product.id}`, {
      body: { quantity: line.quantity },
    });
    if (put.status >= 300)
      throw new Error(
        `cart ${line.product.id}: ${put.status} ${JSON.stringify(put.body)}`,
      );
  }
  const reply = await buyer.post('/api/checkout', {
    body: {},
    key,
    schema: checkoutResponseSchema,
  });
  if (reply.status !== 202)
    throw new Error(`checkout: ${reply.status} ${JSON.stringify(reply.body)}`);
  orderIdsOfThisRun.add((reply.body as CheckoutResponse).orderId);
  return { order: reply.body as CheckoutResponse, checkoutKey: key };
}

/** `POST /payments/intents`; returns the reply so a test can assert the status (`202` or a refusal). */
export function startPayment(
  buyer: JourneyClient,
  orderId: string,
  paymentMethodId: string,
  key: string = randomUUID(),
) {
  return buyer.post('/api/payments/intents', {
    body: { orderId, paymentMethodId },
    key,
    schema: paymentAcceptedSchema,
  });
}

/**
 * Starts the payment, waiting through H1 while payments' order copy is not there yet (`404 order_not_found`, the only
 * answer that means "not yet"); every other refusal is returned as is.
 */
export async function payOrder(
  buyer: JourneyClient,
  orderId: string,
  paymentMethodId = 'pm_test_visa',
  key: string = randomUUID(),
) {
  return waitForContract(
    'H1',
    async () => {
      const reply = await startPayment(buyer, orderId, paymentMethodId, key);
      return reply.status === 404 ? null : reply;
    },
    `payment accepted for order ${orderId}`,
  );
}

export async function getOrder(
  buyer: JourneyClient,
  orderId: string,
): Promise<OrderDto> {
  const reply = await buyer.get(`/api/orders/${orderId}`, {
    schema: orderSchema,
  });
  if (reply.status !== 200)
    throw new Error(
      `order ${orderId}: ${reply.status} ${JSON.stringify(reply.body)}`,
    );
  return reply.body as OrderDto;
}

export async function getPayment(
  buyer: JourneyClient,
  paymentId: string,
): Promise<PaymentView> {
  const reply = await buyer.get(`/api/payments/${paymentId}`, {
    schema: paymentSchema,
  });
  if (reply.status !== 200)
    throw new Error(
      `payment ${paymentId}: ${reply.status} ${JSON.stringify(reply.body)}`,
    );
  return reply.body as PaymentView;
}

export const waitOrderStatus = (
  buyer: JourneyClient,
  orderId: string,
  status: OrderDto['status'],
  hop: 'H3' | 'H3w' | 'H11',
) =>
  waitForContract(
    hop,
    async () => {
      const order = await getOrder(buyer, orderId);
      return order.status === status ? order : null;
    },
    `order ${orderId} ${status}`,
  );

export const waitPaymentStatus = (
  buyer: JourneyClient,
  paymentId: string,
  status: PaymentView['status'],
  hop: 'H2' | 'H2w' | 'H12',
) =>
  waitForContract(
    hop,
    async () => {
      const payment = await getPayment(buyer, paymentId);
      return payment.status === status ? payment : null;
    },
    `payment ${paymentId} ${status}`,
  );

/** A buyer's own balance read of a shop (owner or staff of that shop only). */
export async function getBalance(
  actor: JourneyClient,
  shopId: string,
): Promise<Balance> {
  const reply = await actor.get(`/api/shops/${shopId}/balance`, {
    schema: balanceSchema,
  });
  if (reply.status !== 200)
    throw new Error(
      `balance ${shopId}: ${reply.status} ${JSON.stringify(reply.body)}`,
    );
  return reply.body as Balance;
}

/** Polls the shop balance until `predicate` holds (H4). */
export const waitBalance = (
  seller: SellerFixture,
  predicate: (b: Balance) => boolean,
  what: string,
) =>
  waitForContract(
    'H4',
    async () => {
      const balance = await getBalance(seller.owner, seller.shopId);
      return predicate(balance) ? balance : null;
    },
    what,
  );

/** `POST /orders/:id/cancel` as the buyer; returns the reply so a test can assert the status. */
export const cancelOrder = (buyer: JourneyClient, orderId: string) =>
  buyer.post(`/api/orders/${orderId}/cancel`, { key: randomUUID() });

/** Every order this process checked out: AS-30 looks for exactly these ids in the API log. */
export const orderIdsOfThisRun = new Set<string>();
