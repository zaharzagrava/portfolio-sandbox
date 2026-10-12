import { taskRow } from './append-with-executor';

const task = { type: 'x.requested', aggregateId: 'a1', body: { id: 'a1' } };

describe('taskRow: queue options are checked where the task is created', () => {
  it('refuses a message group on a standard queue (the relay would reject it on every attempt)', () => {
    expect(() =>
      taskRow({ ...task, queue: 'payments-charge', groupId: 'a1' }),
    ).toThrow('groupId is for FIFO queues only');
  });

  it('refuses a FIFO queue without a message group', () => {
    expect(() =>
      taskRow({ ...task, queue: 'webhook-deliveries.fifo' }),
    ).toThrow('a FIFO queue needs a non-empty groupId');
  });

  it('accepts a standard queue without a group, and a FIFO queue with one', () => {
    expect(() => taskRow({ ...task, queue: 'payments-charge' })).not.toThrow();
    expect(() =>
      taskRow({ ...task, queue: 'webhook-deliveries.fifo', groupId: 'a1' }),
    ).not.toThrow();
  });

  it('refuses a delay outside 0..900 seconds', () => {
    expect(() =>
      taskRow({ ...task, queue: 'payments-charge', delaySeconds: 901 }),
    ).toThrow('delaySeconds must be an integer');
  });
});
