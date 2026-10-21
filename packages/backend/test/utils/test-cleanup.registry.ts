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
  private readonly cleaners: {
    name: string;
    order: number;
    run: () => Promise<void>;
  }[] = [];

  register(name: string, run: () => Promise<void>, order = 50): void {
    if (this.cleaners.some((c) => c.name === name)) return;
    this.cleaners.push({ name, order, run });
  }

  /**
   * Cleaners with the same `order` are independent stores (Redis, Scylla, Dynamo), so each group runs at the same time
   * (the wipe takes as long as the slowest store, not the sum). Groups still run one after another in `order`.
   * If several fail, the first failure (in registration order) is thrown after the whole group has finished.
   */
  async runAll(): Promise<void> {
    const sorted = [...this.cleaners].sort((a, b) => a.order - b.order);
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j < sorted.length && sorted[j].order === sorted[i].order) j++;
      const results = await Promise.allSettled(
        sorted.slice(i, j).map((cleaner) => cleaner.run()),
      );
      const failed = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      if (failed) throw failed.reason;
      i = j;
    }
  }
}
