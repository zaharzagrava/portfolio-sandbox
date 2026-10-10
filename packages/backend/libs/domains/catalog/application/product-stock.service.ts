import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  PRODUCT_REPOSITORY,
  STOCK_OPERATION_REPOSITORY,
  type ProductRepository,
  type StockOperationRecord,
  type StockOperationRepository,
} from '../domain/ports';
import {
  ProductValidationError,
  StockOperationConflictError,
} from '../domain/product-errors';
import { stockOperationCounter } from '../domain/product-metrics';
import type { ProductRecord } from '../domain/product-view';
import { applyDelta } from '../domain/stock-rule';
import {
  parseStockOperations,
  type StockOperation,
} from '../domain/stock-input';
import { snapshotEvent } from './events/product-events';
import { ProductCacheInvalidation } from './product-cache-invalidation.service';

export type StockFailureCode =
  'insufficient_stock' | 'unavailable' | 'not_found' | 'quantity_limit';

export type ApplyStockResult =
  | {
      outcome: 'applied';
      results: Array<{
        operationId: string;
        productId: string;
        quantityAfter: number;
        productVersion: number;
        replayed: boolean;
      }>;
    }
  | {
      outcome: 'rejected';
      failures: Array<{
        operationId: string;
        productId: string;
        code: StockFailureCode;
      }>;
    };

/**
 * The only way other capabilities change stock (R1). Per call: one transaction that locks the product rows (ordered by
 * id, so concurrent calls cannot deadlock), decides on the locked rows whether every operation can be applied, and
 * either writes nothing (rejected) or writes everything: the quantity, one record per operation (the idempotency key
 * is its id) and one full-state event per product. All-or-nothing even when the caller's own transaction is joined,
 * because nothing is written until every operation is known to fit. After the commit the cache entries are dropped.
 */
@Injectable()
export class ProductStockService {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(STOCK_OPERATION_REPOSITORY)
    private readonly operations: StockOperationRepository,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly invalidation: ProductCacheInvalidation,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async applyStockDelta(ops: StockOperation[]): Promise<ApplyStockResult> {
    const parsed = parseStockOperations(ops);
    if (!parsed.ok) throw new ProductValidationError(parsed.fields);
    // Stable lock order: by product, then by the caller's order (operations on one product apply in sequence).
    const ordered = parsed.value
      .map((op, index) => ({ op, index }))
      .sort(
        (a, b) =>
          a.op.productId.localeCompare(b.op.productId) || a.index - b.index,
      )
      .map(({ op }) => op);

    const now = this.clock.now();
    const outcome = await this.runner.run(() =>
      this.apply(ordered, parsed.value, now),
    );
    if (outcome.outcome === 'rejected') {
      stockOperationCounter.add(1, { result: 'rejected' });
      return outcome;
    }
    await this.invalidation.afterWrite(outcome.touched);
    for (const r of outcome.results)
      stockOperationCounter.add(1, {
        result: r.replayed ? 'replayed' : 'applied',
      });
    return { outcome: 'applied', results: outcome.results };
  }

  private async apply(
    ordered: StockOperation[],
    asGiven: StockOperation[],
    now: Date,
  ) {
    const productIds = [...new Set(ordered.map((op) => op.productId))];
    const locked = new Map<string, ProductRecord>(
      (await this.products.lockForStock(productIds)).map((p) => [p.id, p]),
    );
    const stored = new Map(
      (await this.operations.findMany(ordered.map((op) => op.operationId))).map(
        (record) => [record.operationId, record],
      ),
    );

    // Phase A: decide on the locked rows; nothing is written yet.
    const running = new Map<string, number>();
    const fresh: Array<{ op: StockOperation; quantityAfter: number }> = [];
    const replays = new Map<string, StockOperationRecord>();
    const failures: Array<{
      operationId: string;
      productId: string;
      code: StockFailureCode;
    }> = [];
    for (const op of ordered) {
      const previous = stored.get(op.operationId);
      if (previous) {
        if (
          previous.productId !== op.productId ||
          previous.shopId !== op.shopId ||
          previous.delta !== op.delta
        ) {
          stockOperationCounter.add(1, { result: 'conflict' });
          throw new StockOperationConflictError();
        }
        replays.set(op.operationId, previous);
        continue;
      }
      const row = locked.get(op.productId);
      if (!row || row.shopId !== op.shopId) {
        failures.push({
          operationId: op.operationId,
          productId: op.productId,
          code: 'not_found',
        });
        continue;
      }
      if (row.status === 'ARCHIVED' && op.delta < 0) {
        failures.push({
          operationId: op.operationId,
          productId: op.productId,
          code: 'unavailable',
        });
        continue;
      }
      const before = running.get(op.productId) ?? row.quantity;
      const next = applyDelta(before, op.delta);
      if (!next.ok) {
        failures.push({
          operationId: op.operationId,
          productId: op.productId,
          code:
            next.reason === 'quantity_limit'
              ? 'quantity_limit'
              : 'insufficient_stock',
        });
        continue;
      }
      running.set(op.productId, next.quantity);
      fresh.push({ op, quantityAfter: next.quantity });
    }
    if (failures.length > 0) return { outcome: 'rejected' as const, failures };

    // Phase B: write. Operations on one product make one version step and one event.
    const finalVersion = new Map<string, number>();
    const events: EventEnvelope[] = [];
    const touched: Array<{ productId: string; version: number }> = [];
    for (const [productId, quantity] of running) {
      const row = locked.get(productId)!;
      const total = quantity - row.quantity;
      const updated =
        total === 0
          ? row
          : await this.products.applyDelta(row.shopId, productId, total, now);
      if (!updated)
        throw new Error(`stock update lost a row it had locked: ${productId}`);
      finalVersion.set(productId, updated.version);
      if (total !== 0) {
        events.push(snapshotEvent('updated', updated, ['quantity']));
        touched.push({ productId, version: updated.version });
      }
    }
    for (const { op, quantityAfter } of fresh) {
      const inserted = await this.operations.insert({
        operationId: op.operationId,
        productId: op.productId,
        shopId: op.shopId,
        delta: op.delta,
        reason: op.reason,
        quantityAfter,
        productVersion: finalVersion.get(op.productId)!,
        appliedAt: now,
      });
      if (!inserted) {
        // The id was claimed meanwhile for a product we do not hold a lock on: a different operation.
        stockOperationCounter.add(1, { result: 'conflict' });
        throw new StockOperationConflictError();
      }
    }
    await this.outbox.append(events);

    const results = asGiven.map((op) => {
      const replay = replays.get(op.operationId);
      if (replay)
        return {
          operationId: op.operationId,
          productId: op.productId,
          quantityAfter: replay.quantityAfter,
          productVersion: replay.productVersion,
          replayed: true,
        };
      const done = fresh.find((f) => f.op.operationId === op.operationId)!;
      return {
        operationId: op.operationId,
        productId: op.productId,
        quantityAfter: done.quantityAfter,
        productVersion: finalVersion.get(op.productId)!,
        replayed: false,
      };
    });
    return { outcome: 'applied' as const, results, touched };
  }
}
