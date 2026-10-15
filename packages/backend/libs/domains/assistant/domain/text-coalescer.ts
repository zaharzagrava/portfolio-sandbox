import type { Clock } from './assistant-ports';

export const COALESCE_INTERVAL_MS = 40;
export const COALESCE_MAX_CHARS = 256;

export interface TextCoalescerOptions {
  clock: Clock;
  intervalMs?: number;
  maxChars?: number;
}

/**
 * Batches model text deltas into `text` events: at most one per 40 ms, none longer than 256 characters, order kept
 * (S46 AS-10). The first delta after a quiet spell goes out at once; later ones wait for the interval or for 256
 * buffered characters. `flush()` must run before the terminal event; after it nothing more is emitted.
 */
export class TextCoalescer {
  private buffer = '';
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly intervalMs: number;
  private readonly maxChars: number;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly options: TextCoalescerOptions,
  ) {
    this.intervalMs = options.intervalMs ?? COALESCE_INTERVAL_MS;
    this.maxChars = options.maxChars ?? COALESCE_MAX_CHARS;
  }

  push(delta: string): void {
    if (this.closed || delta.length === 0) return;
    this.buffer += delta;
    const now = this.options.clock.nowMs();
    if (
      this.buffer.length >= this.maxChars ||
      now - this.lastEmitAt >= this.intervalMs
    ) {
      this.drain(now);
      return;
    }
    this.timer ??= setTimeout(
      () => {
        this.timer = undefined;
        this.drain(this.options.clock.nowMs());
      },
      this.lastEmitAt + this.intervalMs - now,
    );
  }

  /** Sends everything pending and closes the coalescer. */
  flush(): void {
    if (this.closed) return;
    this.clearTimer();
    this.closed = true;
    this.emitChunks(this.buffer);
    this.buffer = '';
  }

  /** Drops what is pending (the reply ended in a refusal) and closes the coalescer. */
  discard(): void {
    this.clearTimer();
    this.closed = true;
    this.buffer = '';
  }

  private drain(now: number): void {
    this.clearTimer();
    const text = this.buffer;
    this.buffer = '';
    this.lastEmitAt = now;
    this.emitChunks(text);
  }

  private emitChunks(text: string): void {
    for (let i = 0; i < text.length; i += this.maxChars)
      this.emit(text.slice(i, i + this.maxChars));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
