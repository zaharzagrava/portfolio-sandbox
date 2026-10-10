import { Clock } from '@app/common/core/clock';
import { RandomSource } from './random-source';

export interface HotKeyDetectorOptions {
  sampleRate?: number;
  threshold?: number;
  windowMs?: number;
  maxTracked?: number;
}

/** How many of the oldest tracked keys are looked at when the table is full and a new key must be admitted. */
const EVICTION_SAMPLE = 8;

/**
 * Sampled hot-key detection: count a random sample of accesses in a short
 * window; keys whose sampled count crosses the threshold are "hot" for the
 * next window and get promoted to the in-process L1 cache, taking load off
 * the single Redis shard that owns them (lesson 03/04 §4 hot keys).
 *
 * Windows roll on the injected clock (not only when a key is touched), and when the table is full the coldest of
 * the oldest tracked keys makes room, so noise cannot keep a newly hot key from being detected (A20).
 */
export class HotKeyDetector {
  private counts = new Map<string, number>();
  private hot = new Set<string>();
  private windowStart: number;
  private readonly sampleRate: number;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly maxTracked: number;

  constructor(
    private readonly clock: Clock,
    private readonly random: RandomSource,
    options: HotKeyDetectorOptions = {},
  ) {
    this.sampleRate = options.sampleRate ?? 0.01;
    this.threshold = options.threshold ?? 20;
    this.windowMs = options.windowMs ?? 10_000;
    this.maxTracked = options.maxTracked ?? 10_000;
    this.windowStart = clock.nowMs();
  }

  record(key: string): void {
    this.roll();
    if (this.random.next() >= this.sampleRate) return;
    if (!this.counts.has(key) && this.counts.size >= this.maxTracked)
      this.evictColdest();
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  isHot(key: string): boolean {
    this.roll();
    return this.hot.has(key);
  }

  /** Number of keys currently tracked (bounded by `maxTracked`). */
  tracked(): number {
    return this.counts.size;
  }

  private evictColdest(): void {
    let victim: string | undefined;
    let victimCount = Infinity;
    let seen = 0;
    for (const [key, count] of this.counts) {
      if (count < victimCount) {
        victim = key;
        victimCount = count;
      }
      if (++seen >= EVICTION_SAMPLE) break;
    }
    if (victim !== undefined) this.counts.delete(victim);
  }

  private roll(): void {
    const elapsed = this.clock.nowMs() - this.windowStart;
    if (elapsed < this.windowMs) return;
    // A whole window without accesses leaves nothing hot.
    this.hot =
      elapsed >= 2 * this.windowMs
        ? new Set()
        : new Set(
            [...this.counts.entries()]
              .filter(([, c]) => c >= this.threshold)
              .map(([k]) => k),
          );
    this.counts = new Map();
    this.windowStart = this.clock.nowMs();
  }
}
