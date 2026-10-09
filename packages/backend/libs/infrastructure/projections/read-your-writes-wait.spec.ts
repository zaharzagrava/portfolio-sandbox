import { FakeClock } from '@app/common/core/clock';
import { MAX_WAIT_MS, waitForVersion } from './read-your-writes-wait';

/** A clock that only moves when the helper sleeps: the wait logic runs in "frozen" time. */
const harness = (random: () => number = () => 0.5) => {
  const clock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));
  const start = clock.nowMs();
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.advance(ms);
  };
  return { clock, sleeps, sleep, elapsed: () => clock.nowMs() - start, random };
};

describe('S53 read-your-writes wait logic', () => {
  it('S53 AS-81: a probe that already reached the version answers reached without waiting', async () => {
    const h = harness();
    const probe = jest.fn().mockResolvedValue(7);
    await expect(
      waitForVersion({ probe, minVersion: 7, budgetMs: 500, ...h }),
    ).resolves.toBe('reached');
    expect(h.sleeps).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('S53 AS-81: a probe that reaches the version at 300 ms answers reached, polling with jitter between 10 and 100 ms', async () => {
    const h = harness(() => 0.5);
    const probe = async () => (h.elapsed() >= 300 ? 7 : 6);

    await expect(
      waitForVersion({ probe, minVersion: 7, budgetMs: 500, ...h }),
    ).resolves.toBe('reached');

    expect(h.elapsed()).toBeGreaterThanOrEqual(300);
    expect(h.elapsed()).toBeLessThan(500);
    expect(h.sleeps[0]).toBe(10); // starts at 10 ms
    for (const ms of h.sleeps) {
      expect(ms).toBeGreaterThanOrEqual(10);
      expect(ms).toBeLessThanOrEqual(100);
    }
  });

  it('S53 AS-81: a probe that never reaches the version times out after exactly the budget', async () => {
    const h = harness();
    await expect(
      waitForVersion({
        probe: async () => 6,
        minVersion: 7,
        budgetMs: 500,
        ...h,
      }),
    ).resolves.toBe('timeout');
    expect(h.elapsed()).toBe(500);
    for (const ms of h.sleeps) {
      expect(ms).toBeGreaterThanOrEqual(1); // the last slice is clipped to the remaining budget
      expect(ms).toBeLessThanOrEqual(100);
    }
  });

  it.each([0, 1, 0.37, 0.999999])(
    'S53 AS-81: with random %s every poll interval stays within 10 to 100 ms except the clipped last one',
    async (r) => {
      const h = harness(() => r);
      await waitForVersion({
        probe: async () => 0,
        minVersion: 1,
        budgetMs: 2_000,
        ...h,
      });
      const body = h.sleeps.slice(0, -1);
      for (const ms of body) {
        expect(ms).toBeGreaterThanOrEqual(10);
        expect(ms).toBeLessThanOrEqual(100);
      }
      expect(h.elapsed()).toBe(2_000);
    },
  );

  it('S53 AS-81: a probe that throws answers unavailable at once, without waiting', async () => {
    const h = harness();
    const probe = async () => {
      throw new Error('checkpoint store down');
    };
    await expect(
      waitForVersion({ probe, minVersion: 7, budgetMs: 500, ...h }),
    ).resolves.toBe('unavailable');
    expect(h.elapsed()).toBe(0);
  });

  it('S53 AS-81: a probe that fails during the wait answers unavailable at that moment', async () => {
    const h = harness();
    const probe = async () => {
      if (h.elapsed() >= 100) throw new Error('went away');
      return 1;
    };
    await expect(
      waitForVersion({ probe, minVersion: 7, budgetMs: 500, ...h }),
    ).resolves.toBe('unavailable');
    expect(h.elapsed()).toBeLessThan(250);
  });

  it.each([
    [2_500, 2_000],
    [2_001, 2_000],
    [2_000, 2_000],
    [1_000, 1_000],
  ])(
    'S53 AS-81: a requested budget of %s ms is clamped to %s ms',
    async (requested, expected) => {
      const h = harness();
      await expect(
        waitForVersion({
          probe: async () => 0,
          minVersion: 1,
          budgetMs: requested,
          ...h,
        }),
      ).resolves.toBe('timeout');
      expect(h.elapsed()).toBe(expected);
      expect(MAX_WAIT_MS).toBe(2_000);
    },
  );

  it('S53 AS-81: a zero budget never waits and reports timeout when behind', async () => {
    const h = harness();
    await expect(
      waitForVersion({
        probe: async () => 0,
        minVersion: 1,
        budgetMs: 0,
        ...h,
      }),
    ).resolves.toBe('timeout');
    expect(h.sleeps).toEqual([]);
  });

  it('S53 AS-81: the probe can be a replica version instead of a checkpoint (any function returning the applied version)', async () => {
    const h = harness();
    let replicaVersion = 3;
    const probe = async () => replicaVersion++; // the replica applies one version per poll
    await expect(
      waitForVersion({ probe, minVersion: 6, budgetMs: 500, ...h }),
    ).resolves.toBe('reached');
  });
});
