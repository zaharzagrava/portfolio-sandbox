import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

/**
 * Warm-up gate behind `/startupz` and the first `/readyz`. Modules add warm-up work with `addWarmup`; the instance
 * counts as started when every task finished. Once started it never regresses (a shutdown is signalled by readiness).
 */
@Injectable()
export class StartupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupService.name);
  private tasks: { name: string; fn: () => Promise<void> }[] = [];
  private started = false;
  private running?: Promise<void>;

  addWarmup(name: string, fn: () => Promise<void>): void {
    if (this.started) {
      this.started = false; // a late warm-up re-opens the gate until it finishes (only before first traffic in practice)
      this.running = undefined;
    }
    this.tasks.push({ name, fn });
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Warm-ups run in the background: the instance must listen (and answer `/startupz` `503`) while they retry. */
  onApplicationBootstrap(): void {
    this.whenStarted().catch((error) =>
      this.logger.error(
        `warm-up failed, instance stays unstarted: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  /** Runs pending warm-ups once and resolves when the instance is started. A failing warm-up keeps it unstarted. */
  whenStarted(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.running ??= (async () => {
      for (const task of this.tasks) {
        await task.fn();
        this.logger.log(`warm-up "${task.name}" done`);
      }
      this.tasks = [];
      this.started = true;
    })();
    return this.running;
  }

  /** Test seam: back to "not started" with no tasks. */
  reset(): void {
    this.started = false;
    this.tasks = [];
    this.running = undefined;
  }
}
