import { describe, expect, it, vi } from 'vitest';
import { createWriteQueue } from './write-queue';

type Call = { productId: string; quantity: number; resolve: (value: string) => void; reject: (error: unknown) => void };

function harness() {
  const calls: Call[] = [];
  const onSettled = vi.fn();
  const send = vi.fn(
    (productId: string, quantity: number) =>
      new Promise<string>((resolve, reject) => {
        calls.push({ productId, quantity, resolve, reject });
      }),
  );
  return { calls, send, onSettled, queue: createWriteQueue(send, { onSettled }) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('cart write queue (W03 UC5)', () => {
  it('W03 AS-04: the first write for a product is sent at once', async () => {
    const { queue, calls } = harness();
    void queue.set('p1', 3);
    expect(calls.map((call) => [call.productId, call.quantity])).toEqual([['p1', 3]]);
  });

  it('W03 AS-04: writes for one product go one at a time, in order, and only the last pending value is sent (last value wins)', async () => {
    const { queue, calls, send } = harness();
    const first = queue.set('p1', 3);
    const second = queue.set('p1', 4);
    const third = queue.set('p1', 5);
    expect(send).toHaveBeenCalledTimes(1);
    calls[0].resolve('after-3');
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls[1].quantity).toBe(5);
    calls[1].resolve('after-5');
    await expect(first).resolves.toBe('after-3');
    await expect(second).resolves.toBe('after-5');
    await expect(third).resolves.toBe('after-5');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('W03 AS-04: different products do not wait for each other', () => {
    const { queue, send } = harness();
    void queue.set('p1', 1);
    void queue.set('p2', 2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('W03 AS-04: onSettled runs once, after the last write of a burst settles, never before', async () => {
    const { queue, calls, onSettled } = harness();
    void queue.set('p1', 3);
    void queue.set('p1', 4);
    void queue.set('p2', 1);
    calls[0].resolve('a');
    await tick();
    expect(onSettled).not.toHaveBeenCalled();
    calls[1].resolve('b');
    await tick();
    expect(onSettled).not.toHaveBeenCalled();
    calls[2].resolve('c');
    await tick();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-07: a failed write rejects its callers, the pending newer value is still sent, and onSettled still runs', async () => {
    const { queue, calls, onSettled } = harness();
    const first = queue.set('p1', 3);
    const second = queue.set('p1', 4);
    const failure = { response: { status: 422 } };
    calls[0].reject(failure);
    await expect(first).rejects.toBe(failure);
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].quantity).toBe(4);
    calls[1].resolve('ok');
    await expect(second).resolves.toBe('ok');
    await tick();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-04: after the queue went idle a new write starts a new burst with its own onSettled', async () => {
    const { queue, calls, onSettled, send } = harness();
    const first = queue.set('p1', 1);
    calls[0].resolve('a');
    await first;
    await tick();
    expect(onSettled).toHaveBeenCalledTimes(1);
    void queue.set('p1', 2);
    expect(send).toHaveBeenCalledTimes(2);
    calls[1].resolve('b');
    await tick();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it('W03 AS-04: isBusy tells whether a product has a write in flight or pending (for aria-busy)', async () => {
    const { queue, calls } = harness();
    expect(queue.isBusy('p1')).toBe(false);
    void queue.set('p1', 2);
    expect(queue.isBusy('p1')).toBe(true);
    expect(queue.isBusy('p2')).toBe(false);
    calls[0].resolve('a');
    await tick();
    expect(queue.isBusy('p1')).toBe(false);
  });
});
