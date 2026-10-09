import { Injectable, Logger } from '@nestjs/common';
import { flushTelemetry } from '@app/common/telemetry/telemetry-flush';

export type ShutdownPhase = 'drain' | 'stop';

export interface ShutdownTask {
  name: string;
  /**
   * Lower runs first, equal orders run concurrently. Bands: 10 stop intake (consumers, pollers, schedulers),
   * 30 end long-lived work, 50 flush buffers, 80 caches and toolkits, 90 close pools and clients, 95 telemetry.
   */
  order: number;
  /** `drain` runs during the HTTP drain (long-lived streams); `stop` (default) runs after it. */
  phase?: ShutdownPhase;
  run: () => Promise<void>;
  timeoutMs?: number;
}

export interface ShutdownRunResult {
  /** Names of the tasks that threw or timed out; any entry makes the process exit 1. */
  failed: string[];
}

const DEFAULT_TASK_TIMEOUT_MS = 10_000;

/**
 * Explicit, ordered shutdown steps. Nest's own hooks run in module order, which says nothing about "stop consuming
 * from Kafka *before* flushing the write-behind buffer *before* closing Redis". Capabilities register tasks here;
 * `installGracefulShutdown` is the only caller of `run` (S54 FR-039, FR-047), after the HTTP drain.
 */
@Injectable()
export class ShutdownRegistry {
  private readonly logger = new Logger(ShutdownRegistry.name);
  private readonly tasks: ShutdownTask[] = [];
  private readonly started = new Set<ShutdownPhase>();
  private begun = false;

  constructor() {
    // Last band: spans written by earlier tasks are still exported (no-op when telemetry is off).
    this.tasks.push({
      name: 'telemetry-flush',
      order: 95,
      timeoutMs: 5_000,
      run: flushTelemetry,
    });
  }

  register(task: ShutdownTask): void {
    if (this.begun) {
      this.logger.error(
        `shutdown task "${task.name}" registered after shutdown began, rejected`,
      );
      throw new Error(
        `cannot register shutdown task "${task.name}": shutdown already began`,
      );
    }
    this.tasks.push(task);
  }

  /** Closes registration; called when the signal arrives. */
  begin(): void {
    this.begun = true;
  }

  /** Runs the tasks of one phase once: ascending order across groups, concurrently inside a group. */
  async run(phase: ShutdownPhase): Promise<ShutdownRunResult> {
    this.begin();
    const failed: string[] = [];
    if (this.started.has(phase)) return { failed };
    this.started.add(phase);

    const groups = new Map<number, ShutdownTask[]>();
    for (const task of this.tasks.filter(
      (t) => (t.phase ?? 'stop') === phase,
    )) {
      groups.set(task.order, [...(groups.get(task.order) ?? []), task]);
    }
    for (const order of [...groups.keys()].sort((a, b) => a - b)) {
      await Promise.all(
        groups.get(order)!.map((task) => this.runTask(task, failed)),
      );
    }
    return { failed };
  }

  private async runTask(task: ShutdownTask, failed: string[]): Promise<void> {
    const started = Date.now();
    try {
      await withTimeout(
        Promise.resolve().then(() => task.run()),
        task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
        task.name,
      );
      this.logger.log(
        `[shutdown] ${task.name} done in ${Date.now() - started}ms`,
      );
    } catch (error) {
      // Keep going: one stuck dependency must not prevent the others from closing cleanly.
      failed.push(task.name);
      this.logger.error(
        `[shutdown] ${task.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Exposed for tests. */
  listTaskNames(): string[] {
    return [...this.tasks].sort((a, b) => a.order - b.order).map((t) => t.name);
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${name} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
