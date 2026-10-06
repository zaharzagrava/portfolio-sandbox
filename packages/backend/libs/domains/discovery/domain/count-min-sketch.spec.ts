import { CountMinSketch, TopK, TumblingWindows } from './count-min-sketch';

/** Streaming primitives shared by trending (SD-32) and any future heavy-hitter use. */
describe('streaming top-K', () => {
  it('Count-Min never undercounts and stays close for heavy keys', () => {
    const cms = new CountMinSketch(1 << 12, 4);
    const exact = new Map<string, number>();
    for (let i = 0; i < 100_000; i++) {
      // Zipf-ish: a few very popular products, a long tail.
      const key = `p${Math.floor(1 / (Math.random() + 1e-4)) % 5_000}`;
      cms.add(key);
      exact.set(key, (exact.get(key) ?? 0) + 1);
    }
    for (const [key, count] of exact) expect(cms.estimate(key)).toBeGreaterThanOrEqual(count);
    const heavy = [...exact].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [key, count] of heavy) expect(cms.estimate(key) - count).toBeLessThan(count * 0.05);
  });

  it('CMS + TopK recover the true top-10 (precision ≥ 0.9)', () => {
    const cms = new CountMinSketch(1 << 14, 4);
    const top = new TopK(10);
    const exact = new Map<string, number>();
    for (let i = 0; i < 200_000; i++) {
      const key = `p${Math.floor(1 / (Math.random() + 1e-4)) % 20_000}`;
      top.offer(key, cms.add(key));
      exact.set(key, (exact.get(key) ?? 0) + 1);
    }
    const truth = new Set([...exact].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k));
    const hits = top.top().filter((t) => truth.has(t.key)).length;
    expect(hits).toBeGreaterThanOrEqual(9);
  });

  it('tumbling windows close behind the watermark and reject late events', () => {
    const windows = new TumblingWindows(60_000, 120_000, () => ({ n: 0 }));
    windows.stateFor(0)!.n++;
    windows.stateFor(59_999)!.n++;
    windows.stateFor(60_000)!.n++;
    expect(windows.closeReady()).toEqual([]); // watermark still negative
    windows.stateFor(181_000); // watermark = 61_000 → window [0, 60s) closes
    expect(windows.closeReady()).toEqual([{ start: 0, state: { n: 2 } }]);
    expect(windows.stateFor(30_000)).toBeNull(); // late for a closed window
    expect(windows.lateEvents).toBe(1);
  });
});
