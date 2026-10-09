import { Priority, SheddingPolicy } from './shedding-policy';

const policyAt = (lag: number, thresholdMs = 200) => {
  const policy = new SheddingPolicy({ thresholdMs, inflightCap: 1000 });
  policy.observe(lag);
  return policy;
};
const admitted = (policy: SheddingPolicy) =>
  (['background', 'default', 'critical'] as Priority[]).filter(
    (p) => policy.decide(p, 0) === 'admit',
  );

describe('SheddingPolicy (U-SHEDP)', () => {
  it.each([
    [0, ['background', 'default', 'critical']],
    [199, ['background', 'default', 'critical']],
    [200, ['default', 'critical']],
    [250, ['default', 'critical']],
    [399, ['default', 'critical']],
    [400, ['critical']],
    [450, ['critical']],
    [999, ['critical']],
    [1000, []],
    [1100, []],
  ])(
    'S54 AS-75: at lag %d ms (T = 200 ms) the admitted tiers are %j',
    (lag, expected) => {
      expect(admitted(policyAt(lag))).toEqual(expected);
    },
  );

  it.each([
    [100, 100, ['default', 'critical']],
    [100, 250, ['critical']],
    [100, 450, ['critical']],
    [100, 500, []],
    [50, 100, ['critical']],
  ])(
    'S54 AS-75: with T = %d ms and lag %d ms the admitted tiers are %j',
    (thresholdMs, lag, expected) => {
      expect(admitted(policyAt(lag, thresholdMs))).toEqual(expected);
    },
  );

  it('S54 AS-77: shedding at lag 250 continues at 190 and stops after two consecutive samples below 0.8 T', () => {
    const policy = policyAt(250);
    expect(policy.decide('background', 0)).toBe('lag');
    policy.observe(190);
    expect(policy.decide('background', 0)).toBe('lag');
    policy.observe(150);
    expect(policy.decide('background', 0)).toBe('lag');
    policy.observe(150);
    expect(policy.decide('background', 0)).toBe('admit');
  });

  it('S54 AS-77: one low sample between high ones does not stop shedding (no flapping on 190/210)', () => {
    const policy = policyAt(250);
    for (const lag of [190, 210, 190, 210, 190, 210]) {
      policy.observe(lag);
      expect(policy.decide('background', 0)).toBe('lag');
    }
    policy.observe(150);
    policy.observe(210);
    policy.observe(150);
    expect(policy.decide('background', 0)).toBe('lag');
  });

  it('S54 AS-77: each tier recovers against its own threshold', () => {
    const policy = policyAt(450);
    expect(admitted(policy)).toEqual(['critical']);
    policy.observe(300);
    policy.observe(300);
    // default tier threshold 400: 0.8 x 400 = 320, so 300 twice stops default; background (160) is still on
    expect(policy.decide('default', 0)).toBe('admit');
    expect(policy.decide('background', 0)).toBe('lag');
  });

  it.each([
    ['background', 4, 'admit'],
    ['background', 5, 'inflight'],
    ['default', 5, 'inflight'],
    ['default', 4, 'admit'],
    ['critical', 5, 'admit'],
    ['critical', 9, 'admit'],
    ['critical', 10, 'inflight'],
  ] as const)(
    'S54 AS-78: with an in-flight cap of 5, a %s request at %d in flight is %s',
    (priority, inflight, expected) => {
      const policy = new SheddingPolicy({ thresholdMs: 200, inflightCap: 5 });
      expect(policy.decide(priority, inflight)).toBe(expected);
    },
  );
});
