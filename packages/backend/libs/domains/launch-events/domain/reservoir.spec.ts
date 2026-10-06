import { Reservoir } from './reservoir';

/** Used by every gateway batcher; pure → plain unit spec. */
describe('Reservoir', () => {
  it('keeps everything while under k, and resets on drain', () => {
    const r = new Reservoir<number>(5);
    [1, 2, 3].forEach((n) => r.offer(n));
    expect(r.drain()).toEqual({ sample: [1, 2, 3], seen: 3 });
    expect(r.drain()).toEqual({ sample: [], seen: 0 });
  });

  it('samples uniformly: every position is picked ~k/n of the time', () => {
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
    // First and last items are not favoured (the classic bug in naive "keep the first k" / "keep the last k").
    for (const i of [0, 1, 50, 98, 99]) expect(Math.abs(hits[i] - expected)).toBeLessThan(expected * 0.15);
  });
});
