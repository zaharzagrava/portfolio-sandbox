import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  acceptPayment,
  createPaymentsApp,
  deliverCharge,
  exec,
  historyOf,
  ledgerOf,
  paymentRow,
  payableBuyer,
  type PaymentsTestApp,
} from './testing';

const settle = () => new Promise((r) => setTimeout(r, 120));

/**
 * The legacy PaymentService suite (duplicate delivery, redelivery after completion, no charge when the goods cannot be
 * sold) restated against the S13 charge path. Stock is no longer a payments concern (A6), so the "out of stock" case is
 * the order copy no longer being payable.
 */
describe('Payments: duplicate delivery and no charge for an unpayable order (e2e, real Postgres)', () => {
  let t: PaymentsTestApp;

  beforeAll(async () => {
    t = await createPaymentsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const eventsOf = async (paymentId: string, type: string) =>
    (await outboxRowsFor(t.app, paymentId)).filter((r) => r.type === type);
  const balanced = (lines: { amount: unknown }[]) =>
    lines.reduce((sum, l) => sum + Number(l.amount), 0);

  describe('idempotency under duplicate delivery', () => {
    it('two concurrent deliveries of the same command → one COMPLETED payment, one balanced ledger set, one outbox event', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);

      await Promise.all([deliverCharge(t, id), deliverCharge(t, id)]);
      await settle();

      expect(t.provider.count('create')).toBe(1);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'COMPLETED',
        version: 2,
      });
      const lines = await ledgerOf(t.app, id);
      expect(lines).toHaveLength(3);
      expect(balanced(lines)).toBe(0);
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(1);
      expect(await historyOf(t.app, id)).toHaveLength(2);
    });

    it('a redelivery after completion returns without charging again', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      await deliverCharge(t, id);
      const before = await paymentRow(t.app, id);

      await deliverCharge(t, id);

      expect(t.provider.count('create')).toBe(1);
      expect(await paymentRow(t.app, id)).toEqual(before);
      expect(await ledgerOf(t.app, id)).toHaveLength(3);
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(1);
    });

    it('two buyers paying at once → each order is charged once and settled on its own', async () => {
      const [first, second] = [await payableBuyer(t), await payableBuyer(t)];
      const [a, b] = [
        await acceptPayment(t, first),
        await acceptPayment(t, second),
      ];

      await Promise.all([deliverCharge(t, a), deliverCharge(t, b)]);
      await settle();

      expect(t.provider.count('create')).toBe(2);
      for (const id of [a, b]) {
        expect((await paymentRow(t.app, id))!.status).toBe('COMPLETED');
        expect(balanced(await ledgerOf(t.app, id))).toBe(0);
      }
    });
  });

  describe('goods that can no longer be sold', () => {
    it('an order that stopped being payable → no provider call, no ledger entries', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      await exec(
        t.app,
        `UPDATE "PayableOrder" SET "status" = 'CANCELLED', "orderVersion" = 2 WHERE "orderId" = :orderId`,
        { orderId: buyer.order.orderId },
      );

      await deliverCharge(t, id);

      expect(t.provider.calls).toHaveLength(0);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'CANCELLED',
        failureCode: 'order_not_payable',
      });
      expect(await ledgerOf(t.app, id)).toHaveLength(0);
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(0);
    });
  });
});
