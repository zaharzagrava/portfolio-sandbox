import {
  BoundedConcurrency,
  hashConcurrencyProblems,
} from './bounded-concurrency';
import { Domain_OverloadedError } from './errors';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('S01 AS-18: bounded hash concurrency', () => {
  it('runs at most `limit` at once and queues up to `maxQueue` more', async () => {
    const gate = new BoundedConcurrency(2, 2);
    let running = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const task = (i: number) => async () => {
      started.push(i);
      running++;
      peak = Math.max(peak, running);
      await gates[i].promise;
      running--;
      return i;
    };

    const results = [0, 1, 2, 3].map((i) => gate.run(task(i)));
    await Promise.resolve();
    expect(started).toEqual([0, 1]); // 2 in flight, 2 queued

    gates[0].resolve();
    await results[0];
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('rejects immediately with Overloaded when the queue is full', async () => {
    const gate = new BoundedConcurrency(1, 1);
    const g = deferred();
    const first = gate.run(() => g.promise);
    const second = gate.run(async () => 'queued');
    await expect(gate.run(async () => 'x')).rejects.toBeInstanceOf(
      Domain_OverloadedError,
    );
    g.resolve();
    await first;
    await expect(second).resolves.toBe('queued');
  });

  it('frees the slot when a task throws', async () => {
    const gate = new BoundedConcurrency(1, 1);
    await expect(
      gate.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });

  describe('startup check', () => {
    it('fails when concurrency exceeds UV_THREADPOOL_SIZE - 1', () => {
      expect(hashConcurrencyProblems(4, 4, false)).toHaveLength(1);
      expect(hashConcurrencyProblems(4, 5, false)).toHaveLength(0);
      expect(hashConcurrencyProblems(4, 8, true)).toHaveLength(0);
    });

    it('treats an unset pool size as the libuv default of 4, enforced in production only', () => {
      expect(hashConcurrencyProblems(4, undefined, true)).toHaveLength(1);
      expect(hashConcurrencyProblems(4, undefined, false)).toHaveLength(0);
    });

    it('names the key, never a value of a secret', () => {
      const [message] = hashConcurrencyProblems(4, 4, false);
      expect(message).toContain('UV_THREADPOOL_SIZE');
    });
  });
});
