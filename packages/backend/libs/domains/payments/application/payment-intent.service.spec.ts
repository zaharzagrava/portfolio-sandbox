import { taskRow } from '@app/infrastructure/outbox/append-with-executor';
import { CHARGE_QUEUE, PaymentIntentService } from './payment-intent.service';

type AppendedTask = Parameters<typeof taskRow>[0];

describe('PaymentIntentService.accept: the charge request', () => {
  it('is a task the outbox accepts for its queue (a standard queue takes no message group)', async () => {
    const tasks: AppendedTask[] = [];
    const service = new PaymentIntentService(
      {
        waitFor: () =>
          Promise.resolve({
            status: 'RESERVED',
            totalMinor: 1999,
            currency: 'USD',
            reservedUntil: new Date(Date.now() + 60_000),
          }),
      } as never,
      {
        insertAccepted: (input: {
          id: string;
          orderId: string;
          amountMinor: number;
          currency: string;
        }) => Promise.resolve({ ...input, createdAt: new Date() }),
        findByOrderId: () => Promise.resolve(null),
      } as never,
      { insert: () => Promise.resolve() } as never,
      { run: (work: () => Promise<unknown>) => work() } as never,
      {
        appendTask: (task: AppendedTask) => {
          tasks.push(task);
          return Promise.resolve();
        },
      } as never,
      { now: () => new Date() } as never,
    );

    await service.accept('user-1', {
      orderId: 'order-1',
      paymentMethodId: 'pm-1',
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].queue).toBe(CHARGE_QUEUE);
    expect(() => taskRow(tasks[0])).not.toThrow(); // the real option check, the one the relay applies on every send
  });
});
