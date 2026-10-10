import * as fc from 'fast-check';
import { CountMinSketch } from './count-min-sketch';
import { seededRandom, zipfSampler } from './testing/seeded-random';

const MAX = 0xffffffff;

function zipfStream(seed: number, events: number, products: number) {
  const next = zipfSampler(products, 1.1, seededRandom(seed));
  const exact = new Map<string, number>();
  const stream: string[] = [];
  for (let i = 0; i < events; i++) {
    const key = `p${next()}`;
    stream.push(key);
    exact.set(key, (exact.get(key) ?? 0) + 1);
  }
  return { stream, exact };
}

describe('S35 Count-Min Sketch (U1)', () => {
  it.each([
    [1 << 12, 4],
    [1 << 13, 4],
    [1 << 12, 6],
  ])(
    'S35 AS-23: width %i depth %i never undercounts and stays inside e/w·N',
    (width, depth) => {
      const { stream, exact } = zipfStream(11, 100_000, 5_000);
      const cms = new CountMinSketch(width, depth);
      for (const key of stream) cms.add(key);
      const bound = (Math.E / width) * stream.length;
      let within = 0;
      for (const [key, count] of exact) {
        const estimate = cms.estimate(key);
        expect(estimate).toBeGreaterThanOrEqual(count);
        if (estimate - count <= bound) within++;
      }
      expect(within / exact.size).toBeGreaterThanOrEqual(1 - Math.exp(-depth));
      const heavy = [...exact].sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [key, count] of heavy)
        expect(cms.estimate(key) - count).toBeLessThan(count * 0.05);
    },
  );

  it('S35 AS-23: a product never added estimates at least 0', () => {
    expect(
      new CountMinSketch(1 << 10, 4).estimate('never'),
    ).toBeGreaterThanOrEqual(0);
  });

  it('S35 AS-23: two sketches of equal dimensions added cell by cell equal one fed the whole stream', () => {
    const { stream } = zipfStream(5, 40_000, 3_000);
    const whole = new CountMinSketch(1 << 11, 4);
    const a = new CountMinSketch(1 << 11, 4);
    const b = new CountMinSketch(1 << 11, 4);
    stream.forEach((key, i) => {
      whole.add(key);
      (i % 2 === 0 ? a : b).add(key);
    });
    a.merge(b);
    for (const key of new Set(stream))
      expect(a.estimate(key)).toBe(whole.estimate(key));
  });

  it('S35 AS-23: merging sketches of different dimensions throws', () => {
    expect(() =>
      new CountMinSketch(1 << 10, 4).merge(new CountMinSketch(1 << 11, 4)),
    ).toThrow();
    expect(() =>
      new CountMinSketch(1 << 10, 4).merge(new CountMinSketch(1 << 10, 3)),
    ).toThrow();
  });

  it('S35 AS-23: memory is width × depth counters whatever the number of distinct products', () => {
    const cms = new CountMinSketch(1 << 12, 4);
    expect(cms.byteSize).toBe((1 << 12) * 4 * 4);
    for (let i = 0; i < 1_000_000; i++) cms.add(`distinct-${i}`);
    expect(cms.byteSize).toBe((1 << 12) * 4 * 4);
  });

  it('S35 AS-28: counters saturate at 2^32-1 and never wrap', () => {
    const cms = new CountMinSketch(1 << 8, 4);
    expect(cms.add('hot', MAX - 1)).toBe(MAX - 1);
    expect(cms.add('hot', 1)).toBe(MAX);
    expect(cms.add('hot', 1_000)).toBe(MAX);
    expect(cms.add('hot', MAX)).toBe(MAX);
    expect(cms.estimate('hot')).toBe(MAX);
  });

  it('S35 AS-28: merge saturates too, and an estimate never decreases as events are added', () => {
    const a = new CountMinSketch(1 << 8, 4);
    const b = new CountMinSketch(1 << 8, 4);
    a.add('hot', MAX - 5);
    b.add('hot', 100);
    a.merge(b);
    expect(a.estimate('hot')).toBe(MAX);
    const c = new CountMinSketch(1 << 8, 4);
    let previous = 0;
    for (const weight of [MAX - 10, 3, 3, 3, 3, 3]) {
      const now = c.add('k', weight);
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  it('S35 AS-23: property - the estimate is never below the exact count', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 200 }),
            fc.integer({ min: 1, max: 5 }),
          ),
          {
            maxLength: 300,
          },
        ),
        (events) => {
          const cms = new CountMinSketch(1 << 6, 3);
          const exact = new Map<string, number>();
          for (const [id, weight] of events) {
            cms.add(`k${id}`, weight);
            exact.set(`k${id}`, (exact.get(`k${id}`) ?? 0) + weight);
          }
          for (const [key, count] of exact)
            if (cms.estimate(key) < count) return false;
          return true;
        },
      ),
      { seed: 42, numRuns: 100 },
    );
  });
});
