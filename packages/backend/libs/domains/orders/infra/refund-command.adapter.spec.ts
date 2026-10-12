import { taskRow } from '@app/infrastructure/outbox/append-with-executor';
import {
  REFUND_REQUESTED_QUEUE,
  RefundCommandAdapter,
} from './refund-command.adapter';

type AppendedTask = Parameters<typeof taskRow>[0];

describe('RefundCommandAdapter.requestRefund: the refund request', () => {
  it('is a task the outbox accepts for its queue (a standard queue takes no message group)', async () => {
    const tasks: AppendedTask[] = [];
    const adapter = new RefundCommandAdapter(
      {
        appendTask: (task: AppendedTask) => {
          tasks.push(task);
          return Promise.resolve();
        },
      } as never,
      { recordOnce: () => Promise.resolve(true) } as never,
    );

    await adapter.requestRefund({
      orderId: 'order-1',
      paymentRef: 'pay-1',
      amountMinor: 1999,
      currency: 'USD',
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].queue).toBe(REFUND_REQUESTED_QUEUE);
    expect(() => taskRow(tasks[0])).not.toThrow();
  });

  it('asks only once per payment', async () => {
    const appendTask = jest.fn(() => Promise.resolve());
    const adapter = new RefundCommandAdapter(
      { appendTask } as never,
      { recordOnce: () => Promise.resolve(false) } as never,
    );
    await adapter.requestRefund({
      orderId: 'o',
      paymentRef: 'p',
      amountMinor: 1,
      currency: 'USD',
    });
    expect(appendTask).not.toHaveBeenCalled();
  });
});
