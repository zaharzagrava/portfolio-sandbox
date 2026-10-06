import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';

export interface ShutdownTask {
  name: string;
  /** Lower runs first: 10 = stop intake (consumers/pollers), 50 = flush buffers, 90 = close pools. */
  order: number;
  run: () => Promise<void>;
  timeoutMs?: number;
}

/**
 * Explicit, ordered shutdown steps. Nest's own hooks run in module order, which
 * says nothing about "stop consuming from Kafka *before* flushing the
 * write-behind buffer *before* closing Redis". Domains register tasks here.
 */
@Injectable()
export class ShutdownRegistry implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownRegistry.name);
  private readonly tasks: ShutdownTask[] = [];

  register(task: ShutdownTask): void {
    this.tasks.push(task);
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    const ordered = [...this.tasks].sort((a, b) => a.order - b.order);

    for (const task of ordered) {
      const started = Date.now();
      try {
        await withTimeout(task.run(), task.timeoutMs ?? 10_000, task.name);
        this.logger.log(`[shutdown:${signal ?? 'manual'}] ${task.name} done in ${Date.now() - started}ms`);
      } catch (error) {
        // Keep going: one stuck dependency must not prevent the others from closing cleanly.
        this.logger.error(`[shutdown] ${task.name} failed: ${(error as Error).message}`);
      }
    }
  }

  /** Exposed for tests. */
  listTaskNames(): string[] {
    return [...this.tasks].sort((a, b) => a.order - b.order).map((t) => t.name);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
