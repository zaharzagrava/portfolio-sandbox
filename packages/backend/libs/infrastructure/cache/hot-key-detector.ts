/**
 * Sampled hot-key detection: count a random sample of accesses in a short
 * window; keys whose sampled count crosses the threshold are "hot" for the
 * next window and get promoted to the in-process L1 cache, taking load off
 * the single Redis shard that owns them (lesson 03/04 §4 hot keys).
 */
export class HotKeyDetector {
  private counts = new Map<string, number>();
  private hot = new Set<string>();
  private windowStart: number;

  constructor(
    private readonly sampleRate = 0.01,
    private readonly threshold = 20,
    private readonly windowMs = 10_000,
    private readonly maxTracked = 10_000,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {
    this.windowStart = now();
  }

  record(key: string): void {
    this.roll();
    if (this.random() >= this.sampleRate) return;
    if (!this.counts.has(key) && this.counts.size >= this.maxTracked) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  isHot(key: string): boolean {
    this.roll();
    return this.hot.has(key);
  }

  private roll(): void {
    if (this.now() - this.windowStart < this.windowMs) return;
    this.hot = new Set(
      [...this.counts.entries()]
        .filter(([, c]) => c >= this.threshold)
        .map(([k]) => k),
    );
    this.counts = new Map();
    this.windowStart = this.now();
  }
}
