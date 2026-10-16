import { Reservoir } from './reservoir';

/** Used by every gateway batcher; pure → plain unit spec. */
describe('Reservoir', () => {
  it('S23 AS-01: keeps everything while under k, and resets on drain', () => {
    const r = new Reservoir<number>(5);
    [1, 2, 3].forEach((n) => r.offer(n));
    expect(r.drain()).toEqual({ sample: [1, 2, 3], seen: 3 });
    expect(r.drain()).toEqual({ sample: [], seen: 0 });
  });

  it('S23 AS-01: samples uniformly: every position is picked ~k/n of the time', () => {
    const n = 100;
    const k = 5;
    const hits = new Array(n).fill(0);
    const trials = 20_000;
    for (let t = 0; t < trials; t++) {
      const r = new Reservoir<number>(k);
      for (let i = 0; i < n; i++) r.offer(i);
      for (const i of r.drain().sample) hits[i]++;
    }
    const expected = (trials * k) / n; // 1,000
    // Every position is inside the bound, not only the ends (the classic bug of "keep the first k" / "keep the last k").
    // 5 binomial standard deviations of (trials, k/n) is ~160: the bound is wide enough never to flake.
    const sigma = Math.sqrt(trials * (k / n) * (1 - k / n));
    for (let i = 0; i < n; i++)
      expect(Math.abs(hits[i] - expected)).toBeLessThan(5 * sigma);
    // The first and the last item are not favoured.
    expect(Math.abs(hits[0] - hits[n - 1])).toBeLessThan(6 * sigma);
  });

  it('S23 AS-01: the sample never holds more than k items and reports how many were seen', () => {
    const r = new Reservoir<number>(5);
    for (let i = 0; i < 1_250; i++) r.offer(i);
    const { sample, seen } = r.drain();
    expect(sample).toHaveLength(5);
    expect(seen).toBe(1_250);
    expect(new Set(sample).size).toBe(5);
  });

  it('S23 AS-01: uses the injected random source (the draw is deterministic with it)', () => {
    const run = () => {
      let state = 7;
      const random = () => {
        state = (state * 48271) % 2147483647;
        return state / 2147483647;
      };
      const r = new Reservoir<number>(3, random);
      for (let i = 0; i < 50; i++) r.offer(i);
      return r.drain().sample;
    };
    expect(run()).toEqual(run());
  });

  it.each([0, -1, 1.5, Number.NaN])('S23 AS-01: k = %s is rejected', (k) => {
    expect(() => new Reservoir<number>(k)).toThrow(RangeError);
  });
});
