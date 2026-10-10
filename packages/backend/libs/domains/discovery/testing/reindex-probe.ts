import type { ReindexProbe, ReindexRunRecord } from '../domain/ports';

/** A latch a spec opens by hand: the run waits at `wait()` until `release()`; `reached` tells the spec it got there. */
export class Gate {
  private open!: () => void;
  private readonly opened = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  private arrive!: () => void;
  readonly reached = new Promise<void>((resolve) => {
    this.arrive = resolve;
  });

  async wait(): Promise<void> {
    this.arrive();
    await this.opened;
  }

  release(): void {
    this.open();
  }
}

/**
 * The probe the specs bind: every hook delegates to a function the spec sets for the scenario (or nothing), and
 * `reset()` clears them between tests.
 */
export class TestReindexProbe implements ReindexProbe {
  hooks: ReindexProbe = {};
  runs: ReindexRunRecord[] = [];

  reset(): void {
    this.hooks = {};
    this.runs = [];
  }

  afterBuildingStarted(run: ReindexRunRecord) {
    return this.hooks.afterBuildingStarted?.(run) ?? Promise.resolve();
  }

  afterBatch(run: ReindexRunRecord, batch: number) {
    return this.hooks.afterBatch?.(run, batch) ?? Promise.resolve();
  }

  afterReplay(run: ReindexRunRecord) {
    return this.hooks.afterReplay?.(run) ?? Promise.resolve();
  }

  beforeSwitch(run: ReindexRunRecord) {
    return this.hooks.beforeSwitch?.(run) ?? Promise.resolve();
  }

  afterSwitch(run: ReindexRunRecord) {
    return this.hooks.afterSwitch?.(run) ?? Promise.resolve();
  }
}
