import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { STATEMENTS_CONFIG, type StatementsConfig } from '../domain/config';
import type { StopSignal } from '../domain/ports';

/**
 * Graceful shutdown of the statements (S16 FR-049, AS-80). On the signal, close and reconcile work stops between
 * batches (the period stays `CLOSING`, resumable), and open CSV exports get `STATEMENTS_DRAIN_MS` to finish before
 * they are aborted like any failed export.
 */
@Injectable()
export class StatementsLifecycle implements StopSignal, OnModuleInit {
  private stopping = false;
  private readonly exports = new Map<symbol, () => void>();
  private idle: (() => void) | null = null;

  constructor(
    @Inject(STATEMENTS_CONFIG) private readonly config: StatementsConfig,
    @Optional() private readonly shutdown?: ShutdownRegistry,
  ) {}

  onModuleInit(): void {
    this.shutdown?.register({
      name: 'statements-stop-work',
      order: 10,
      run: async () => {
        this.stopping = true;
      },
    });
    this.shutdown?.register({
      name: 'statements-drain-exports',
      order: 30,
      phase: 'drain',
      timeoutMs: this.config.drainMs + 2_000,
      run: () => this.drainExports(),
    });
  }

  isStopping(): boolean {
    return this.stopping;
  }

  /** Tests and the shutdown task: stop starting and continuing long work. */
  beginShutdown(): void {
    this.stopping = true;
  }

  /** An export registers itself for as long as it streams; `abort` is how it is cut off after the drain time. */
  trackExport(abort: () => void): () => void {
    const key = Symbol('export');
    this.exports.set(key, abort);
    return () => {
      this.exports.delete(key);
      if (this.exports.size === 0) this.idle?.();
    };
  }

  get activeExports(): number {
    return this.exports.size;
  }

  async drainExports(): Promise<void> {
    this.stopping = true;
    if (this.exports.size === 0) return;
    await new Promise<void>((resolve) => {
      this.idle = resolve;
      setTimeout(resolve, this.config.drainMs).unref();
    });
    for (const abort of [...this.exports.values()]) abort();
  }
}
