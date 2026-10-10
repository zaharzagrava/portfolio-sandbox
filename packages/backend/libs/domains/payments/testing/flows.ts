import { randomUUID } from 'node:crypto';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { ChargeCommandWorker } from '../infra/charge-command.worker';
import type { PaymentsTestApp } from './payments-app';
import { publishOrderReserved, type ReservedOrder } from './fixtures';

type User = Awaited<ReturnType<PaymentsTestApp['newUser']>>;

export interface PayableBuyer {
  user: User;
  order: ReservedOrder;
}

/** A buyer with a reserved order (EUR 25.00 by default): the copy exists and is payable. */
export async function payableBuyer(
  t: PaymentsTestApp,
  over: { totalMinor?: number; currency?: string; holdSeconds?: number } = {},
): Promise<PayableBuyer> {
  const user = await t.newUser();
  const order = await publishOrderReserved(t.app, { userId: user.id, ...over });
  return { user, order };
}

/** `POST /payments/intents` for the buyer's order; returns the new payment id. */
export async function acceptPayment(
  t: PaymentsTestApp,
  buyer: PayableBuyer,
  paymentMethodId = 'pm_card_visa',
): Promise<string> {
  const res = await t
    .as(buyer.user)
    .post('/api/payments/intents')
    .set('Idempotency-Key', `key-${randomUUID()}`)
    .send({ orderId: buyer.order.orderId, paymentMethodId });
  if (res.status !== 202)
    throw new Error(`accept failed: ${res.status} ${res.text}`);
  return res.body.paymentId as string;
}

/** The body of the charge command the accept transaction wrote to the outbox. */
export async function chargeCommandOf(
  t: PaymentsTestApp,
  paymentId: string,
): Promise<{ paymentId: string; attempt: number }> {
  const task = (await outboxRowsFor(t.app, paymentId)).find(
    (r) => r.kind === 'task' && r.type === 'payments.charge_requested',
  );
  if (!task) throw new Error(`no charge command for ${paymentId}`);
  return (task.payload as { body: { paymentId: string; attempt: number } })
    .body;
}

/** Delivers the payment's charge command to the worker, as the queue would. */
export async function deliverCharge(
  t: PaymentsTestApp,
  paymentId: string,
): Promise<void> {
  const body = await chargeCommandOf(t, paymentId);
  await t.app.get(ChargeCommandWorker, { strict: false }).handle({ body });
}

/** Accept and charge in one go. */
export async function acceptAndCharge(
  t: PaymentsTestApp,
  buyer: PayableBuyer,
): Promise<string> {
  const id = await acceptPayment(t, buyer);
  await deliverCharge(t, id);
  return id;
}
