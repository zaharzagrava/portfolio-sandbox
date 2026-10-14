import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ProductStockService } from '@app/domains/catalog';
import {
  BULK_JOB_ID,
  BULK_LIMITS,
  type BulkStockItem,
} from '@marketplace-sandbox/contracts';
import {
  bulkStatus,
  chunkCount,
  splitIntoChunks,
} from '../domain/bulk-chunking';
import {
  type ItemOutcome,
  StockAnswer,
  syncStatus,
  toOutcomes,
} from '../domain/bulk-outcomes';
import { resourceMissing } from '../domain/errors';
import { BulkJobRepository } from '../domain/ports';
import type { ApiContext } from './api-context';
import { PublicCatalogService } from './public-catalog.service';
import { translateUpstream } from './upstream-errors';

export const BULK_STOCK_REASON = 'public-api.bulk-stock';

export type BulkSubmitResult =
  | {
      status: 200;
      body: {
        object: 'bulk_stock_update';
        status: 'succeeded' | 'failed';
        results: ItemOutcome[];
      };
    }
  | {
      status: 202;
      location: string;
      body: {
        object: 'bulk_stock_update';
        id: string;
        status: 'processing';
        total: number;
        chunks: number;
      };
    };

/**
 * Stock as deltas with operation ids (FR-046…FR-048): up to 100 items are applied at once and all-or-nothing through the
 * catalog's stock service; more become a durable job whose chunks of 100 are applied by the worker, each idempotent per
 * operation id. Products that are not the key's shop's are found in one batch lookup and reported `not_found`.
 */
@Injectable()
export class BulkStockService {
  constructor(
    private readonly catalog: PublicCatalogService,
    private readonly stock: ProductStockService,
    private readonly jobs: BulkJobRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async submit(
    ctx: ApiContext,
    items: BulkStockItem[],
  ): Promise<BulkSubmitResult> {
    if (items.length <= BULK_LIMITS.syncItemsMax) {
      const { outcomes, rejected } = await this.apply(ctx.shopId, items);
      return {
        status: 200,
        body: {
          object: 'bulk_stock_update',
          status: syncStatus(outcomes, rejected),
          results: outcomes,
        },
      };
    }
    const id = `bsu_${randomUUID().replace(/-/g, '')}`;
    const messages = splitIntoChunks(items).map((chunk, index) => ({
      jobId: id,
      shopId: ctx.shopId,
      index,
      items: chunk,
    }));
    await this.jobs.create({
      id,
      shopId: ctx.shopId,
      total: items.length,
      messages,
      now: this.clock.now(),
    });
    return {
      status: 202,
      location: `/v1/stock/bulk/${id}`,
      body: {
        object: 'bulk_stock_update',
        id,
        status: 'processing',
        total: items.length,
        chunks: chunkCount(items.length),
      },
    };
  }

  async job(ctx: ApiContext, jobId: string) {
    if (!BULK_JOB_ID.test(jobId)) throw resourceMissing();
    const job = await this.jobs.find(ctx.shopId, jobId);
    if (!job) throw resourceMissing();
    return {
      object: 'bulk_stock_update' as const,
      id: job.id,
      status: bulkStatus(job),
      total: job.total,
      applied: job.applied,
      replayed: job.replayed,
      failed: job.failed,
      failures: job.failures,
      completed_chunks: job.completedChunks,
      created_at: job.createdAt.toISOString(),
    };
  }

  /** One chunk or one synchronous call: the lookup, the all-or-nothing stock call, the outcome of every item. */
  async apply(
    shopId: string,
    items: readonly BulkStockItem[],
  ): Promise<{ outcomes: ItemOutcome[]; rejected: boolean }> {
    const owned = await this.catalog.ownedIds(
      shopId,
      items.map((i) => i.productId),
    );
    const missing = new Set(
      items
        .filter((i) => !owned.has(i.productId.toLowerCase()))
        .map((i) => i.productId),
    );
    const apply = items.filter((i) => !missing.has(i.productId));
    let answer: StockAnswer | undefined;
    if (apply.length > 0) {
      try {
        answer = (await this.stock.applyStockDelta(
          apply.map((i) => ({
            operationId: i.operationId,
            productId: i.productId.toLowerCase(),
            shopId,
            delta: i.delta,
            reason: BULK_STOCK_REASON,
          })),
        )) as StockAnswer;
      } catch (error) {
        return translateUpstream(error);
      }
    }
    return {
      outcomes: toOutcomes(items, missing, answer),
      rejected: answer?.outcome === 'rejected',
    };
  }
}
