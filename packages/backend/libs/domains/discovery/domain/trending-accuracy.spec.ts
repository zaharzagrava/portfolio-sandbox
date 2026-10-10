import { CountMinSketch } from './count-min-sketch';
import { TopK } from './top-k';
import { TRENDING_DEFAULTS } from './trending-config';
import { seededRandom, zipfSampler } from './testing/seeded-random';

describe('S35 accuracy of the approximation (U8)', () => {
  it('S35 AS-25: precision of the approximate top 10 is at least 0.9 on a seeded stream and no count is below the truth', () => {
    const events = 200_000;
    const products = 20_000;
    const next = zipfSampler(products, 1.1, seededRandom(2026));
    const sketch = new CountMinSketch(
      TRENDING_DEFAULTS.allWidth,
      TRENDING_DEFAULTS.depth,
    );
    const heap = new TopK(10);
    const exact = new Map<string, number>();
    for (let i = 0; i < events; i++) {
      const key = `p${next()}`;
      heap.offer(key, sketch.add(key));
      exact.set(key, (exact.get(key) ?? 0) + 1);
    }
    expect(exact.size).toBeGreaterThan(5_000);
    const truth = [...exact]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10)
      .map(([key]) => key);
    const held = heap.top();
    const hits = held.filter((e) => truth.includes(e.key)).length;
    expect(hits).toBeGreaterThanOrEqual(9);
    for (const entry of held)
      expect(entry.count).toBeGreaterThanOrEqual(exact.get(entry.key)!);
  });
});
