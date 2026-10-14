import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  bulkChunkMessageSchema,
  type BulkChunkMessage,
} from '@marketplace-sandbox/contracts';
import { chunkTotals, type ItemOutcome } from '../domain/bulk-outcomes';
import { ApiError } from '../domain/errors';
import { BulkJobRepository } from '../domain/ports';
import { BulkStockService } from './bulk-stock.service';
import { apiMetrics } from './metrics';

/**
 * One chunk of a bulk stock job (FR-046, FR-047, AS-51). At-least-once delivery is made harmless in two places: the
 * stock service applies an operation id once (a redelivery answers `replayed`), and the chunk's marker is flipped in the
 * same transaction that adds its counts, so however often a chunk arrives, or whenever the worker crashed, the counters
 * end exact. A chunk already done is acknowledged at once.
 */
@Injectable()
export class BulkChunkWorker {
  constructor(
    private readonly stock: BulkStockService,
    private readonly jobs: BulkJobRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The body is validated by the queue consumer (`bodySchema`): an invalid one never gets here and is dead-lettered. */
  async handle(message: BulkChunkMessage): Promise<'recorded' | 'duplicate'> {
    const body = bulkChunkMessageSchema.parse(message);
    const state = await this.jobs.chunkState(body.jobId, body.index);
    if (state !== 'pending') {
      if (state === 'done') apiMetrics.bulkChunkReplayed().add(1);
      return 'duplicate';
    }
    let outcomes: ItemOutcome[];
    try {
      outcomes = (await this.stock.apply(body.shopId, body.items)).outcomes;
    } catch (error) {
      // an operation id reused for another change cannot succeed on a retry: the chunk is recorded as failed
      if (!(error instanceof ApiError && error.code === 'operation_conflict'))
        throw error;
      outcomes = body.items.map((i) => ({
        operation_id: i.operationId,
        product_id: i.productId,
        outcome: 'conflict' as const,
      }));
    }
    const result = await this.jobs.completeChunk({
      jobId: body.jobId,
      shopId: body.shopId,
      index: body.index,
      totals: chunkTotals(outcomes),
      now: this.clock.now(),
    });
    if (result === 'duplicate') apiMetrics.bulkChunkReplayed().add(1);
    return result;
  }
}
