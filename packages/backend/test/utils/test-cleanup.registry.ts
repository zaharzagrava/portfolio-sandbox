import { Injectable } from '@nestjs/common';
import { TestCleanupPort } from '@app/common/testing/test-cleanup.port';

/**
 * Each store-backed module registers how to wipe its test data (truncate
 * Scylla tables, delete Dynamo items, flush the test Redis DB, purge queues).
 * `SeedsService.clean()` runs them all, so specs keep a single
 * `await seedsService.clean()` in `beforeEach` regardless of how many stores
 * a feature touches.
 */
@Injectable()
export class TestCleanupRegistry implements TestCleanupPort {
  private readonly cleaners: { name: string; order: number; run: () => Promise<void> }[] = [];

  register(name: string, run: () => Promise<void>, order = 50): void {
    if (this.cleaners.some((c) => c.name === name)) return;
    this.cleaners.push({ name, order, run });
  }

  async runAll(): Promise<void> {
    for (const cleaner of [...this.cleaners].sort((a, b) => a.order - b.order)) {
      await cleaner.run();
    }
  }
}
