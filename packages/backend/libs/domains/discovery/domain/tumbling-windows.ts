export interface WindowConfig {
  windowMs: number;
  latenessMs: number;
  /** A partition silent for this long is advanced by the wall clock. */
  idleMs: number;
  /** How far back a closed window still accepts a correction (the serving horizon). */
  horizonMs: number;
}

/** `open`: counts into its window; `late_corrected`: the window is closed but inside the horizon; `late_dropped`: older. */
export type Classification = 'open' | 'late_corrected' | 'late_dropped';

export interface WindowEntry<S> {
  start: number;
  state: S;
  firstOffset: number;
  lastOffset: number;
  /** Set when the watermark (or a forced close) passed the window's end; it never reopens. */
  closed: boolean;
}

export const windowStartOf = (timeMs: number, windowMs: number): number =>
  timeMs - (((timeMs % windowMs) + windowMs) % windowMs);

/**
 * Tumbling windows of ONE partition by event time (S35 FR-012 to FR-014, research R-4, R-5, R-6). Pure: every method that
 * depends on the current time takes it as a parameter.
 *
 *   watermark = max(min(maxEventTime, maxReceivedAt) - lateness, idleWatermark)
 *
 * A window closes when the watermark has reached its end. A partition with no message for `idleMs` raises its watermark to
 * `now - lateness`; a partition that keeps receiving messages is never advanced by the clock. A window is `open → closed →
 * merged` (removed); a closed window never reopens: later events for it are corrections or dropped.
 */
export class PartitionWindows<S> {
  private readonly entries = new Map<number, WindowEntry<S>>();
  private maxEventTime = Number.NEGATIVE_INFINITY;
  private maxReceivedAt = Number.NEGATIVE_INFINITY;
  private lastMessageAt: number | null = null;
  private idleWatermark = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly cfg: WindowConfig,
    private readonly create: () => S,
  ) {}

  watermark(): number {
    const fromEvents =
      Math.min(this.maxEventTime, this.maxReceivedAt) - this.cfg.latenessMs;
    return Math.max(fromEvents, this.idleWatermark);
  }

  /** Where an event of this time goes, judged against the watermark BEFORE the event moves it. */
  classify(eventTimeMs: number, nowMs: number): Classification {
    const start = windowStartOf(eventTimeMs, this.cfg.windowMs);
    const existing = this.entries.get(start);
    const closed =
      existing?.closed ?? start + this.cfg.windowMs <= this.watermark();
    if (!closed) return 'open';
    const horizonStart =
      windowStartOf(nowMs, this.cfg.windowMs) - this.cfg.horizonMs;
    return start >= horizonStart ? 'late_corrected' : 'late_dropped';
  }

  /** Records a delivered message: moves the maxima and the time of the last message. */
  observe(m: {
    eventTimeMs: number;
    receivedAtMs: number;
    nowMs: number;
  }): void {
    this.maxEventTime = Math.max(this.maxEventTime, m.eventTimeMs);
    this.maxReceivedAt = Math.max(this.maxReceivedAt, m.receivedAtMs);
    this.lastMessageAt = m.nowMs;
  }

  /** The open window of this event time (created on first use); `offset` widens its covered offsets. */
  open(eventTimeMs: number, offset: number): WindowEntry<S> {
    const start = windowStartOf(eventTimeMs, this.cfg.windowMs);
    let entry = this.entries.get(start);
    if (entry?.closed) throw new Error('a closed window never reopens');
    if (!entry) {
      entry = {
        start,
        state: this.create(),
        firstOffset: offset,
        lastOffset: offset,
        closed: false,
      };
      this.entries.set(start, entry);
    } else {
      entry.firstOffset = Math.min(entry.firstOffset, offset);
      entry.lastOffset = Math.max(entry.lastOffset, offset);
    }
    return entry;
  }

  /** Idle rule: advances the watermark with the wall clock only for a partition silent for `idleMs`. */
  tick(nowMs: number): void {
    if (this.lastMessageAt === null) return;
    if (nowMs - this.lastMessageAt < this.cfg.idleMs) return;
    this.idleWatermark = Math.max(
      this.idleWatermark,
      nowMs - this.cfg.latenessMs,
    );
  }

  /** Every closed window not merged yet (new ones and earlier merge failures), oldest first. */
  closeReady(): WindowEntry<S>[] {
    const watermark = this.watermark();
    for (const entry of this.entries.values())
      if (entry.start + this.cfg.windowMs <= watermark) entry.closed = true;
    return this.unmerged((e) => e.closed);
  }

  /** Shutdown: closes every open window regardless of the watermark. */
  closeAll(): WindowEntry<S>[] {
    for (const entry of this.entries.values()) entry.closed = true;
    return this.unmerged(() => true);
  }

  markMerged(start: number): void {
    this.entries.delete(start);
  }

  /** First offsets of every unmerged window (open or closed): they hold the commit floor. */
  firstOffsets(): number[] {
    return [...this.entries.values()].map((e) => e.firstOffset);
  }

  openCount(): number {
    return this.entries.size;
  }

  /** The oldest unmerged window start, for the age gauge. */
  oldestStart(): number | null {
    let oldest: number | null = null;
    for (const start of this.entries.keys())
      if (oldest === null || start < oldest) oldest = start;
    return oldest;
  }

  private unmerged(keep: (e: WindowEntry<S>) => boolean): WindowEntry<S>[] {
    return [...this.entries.values()]
      .filter(keep)
      .sort((a, b) => a.start - b.start);
  }
}
