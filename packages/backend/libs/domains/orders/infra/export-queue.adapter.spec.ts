import type { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  ExportQueueAdapter,
  ORDER_EXPORTS_QUEUE,
} from './export-queue.adapter';

describe('ExportQueueAdapter', () => {
  const adapter = () => {
    const enqueue = jest.fn().mockResolvedValue('m');
    return {
      enqueue,
      queue: new ExportQueueAdapter({ enqueue } as unknown as TaskQueue),
    };
  };

  it('S12 L-001: the message is {exportId} on the standard queue and never carries a group or dedupe id', async () => {
    const { enqueue, queue } = adapter();

    await queue.enqueue('0192f3a0-0000-7000-8000-000000000001');
    await queue.enqueue('0192f3a0-0000-7000-8000-000000000001', {
      delaySeconds: 60,
    });

    expect(ORDER_EXPORTS_QUEUE).toBe('order-exports');
    expect(enqueue.mock.calls).toEqual([
      [
        'order-exports',
        { exportId: '0192f3a0-0000-7000-8000-000000000001' },
        undefined,
      ],
      [
        'order-exports',
        { exportId: '0192f3a0-0000-7000-8000-000000000001' },
        { delaySeconds: 60 },
      ],
    ]);
    for (const [, , options] of enqueue.mock.calls) {
      expect(options ?? {}).not.toHaveProperty('groupId');
      expect(options ?? {}).not.toHaveProperty('dedupeId');
    }
  });
});
