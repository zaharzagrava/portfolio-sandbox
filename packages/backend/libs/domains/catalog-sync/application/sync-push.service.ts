import { Inject, Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  SyncField,
  SyncOpResult,
  SyncPushResponse,
} from '@marketplace-sandbox/contracts';
import { RequestContext } from '@app/infrastructure/context';
import { ShopNotActiveError } from '@app/domains/catalog';
import { decodeHlc, expired, plausible } from '../domain/hlc';
import {
  SYNC_CATALOG_GATEWAY,
  SYNC_CLOCK,
  SYNC_CONFIG,
  SYNC_FIELD_CLOCK_REPOSITORY,
  SYNC_MONOTONIC,
  SYNC_OPERATION_REPOSITORY,
  SYNC_PRODUCT_EDIT_LOCK,
  type Clock,
  type ConflictInput,
  type Monotonic,
  type ProductEditLock,
  type SyncCatalogGateway,
  type SyncConfig,
  type SyncFieldClockRepository,
  type SyncOperationRepository,
  type SyncOperationRow,
} from '../domain/ports';
import { syncProblem } from '../domain/catalog-sync-errors';
import { decideFields, stockDeltaOf } from '../domain/sync-merge';
import { classifyCatalogFailure, clampDelta } from '../domain/sync-outcome';
import {
  fingerprint,
  opFromRecord,
  opIdOf,
  parseOp,
  payloadOf,
  type SyncOp,
} from '../domain/sync-ops';
import {
  logOperation,
  logPush,
  offlineOpsCounter,
  offlineOpsInFlightGauge,
  offlinePushDuration,
} from './offline-sync-metrics';
import { SyncClockService } from './sync-clock.service';
import {
  outcomeOf,
  rejection,
  resultOf,
  retryResult,
  type Executed,
} from './sync-results';

export interface PushContext {
  shopId: string;
  /** From the session, never from the body. */
  userId: string;
  /** From `X-Device-Id`, never from the body. */
  deviceId: string;
}

/** A claim younger than this is probably being worked on right now: wait for it instead of answering at once. */
const FRESH_CLAIM_MS = 5_000;
const IN_FLIGHT_WAIT_MS = 3_000;
const POLL_MS = 25;
const FIELD_ATTEMPTS = 3;
const CLAMP_ATTEMPTS = 3;
const EDIT_LOCK_WAIT_MS = 10_000;

/**
 * Push (FR-001…FR-014, FR-020…FR-022): per operation, in the order given — validate, claim (committed first), call the
 * catalog with a deterministic operation id, record the result. No catalog call happens inside a transaction of this
 * capability (R-01), so a crash anywhere is repaired by the repeat: the catalog's own per-id idempotency makes the
 * second call return the first call's effect.
 */
@Injectable()
export class SyncPushService {
  private readonly logger = new Logger(SyncPushService.name);
  private inFlight = 0;

  constructor(
    @Inject(SYNC_OPERATION_REPOSITORY)
    private readonly ops: SyncOperationRepository,
    @Inject(SYNC_FIELD_CLOCK_REPOSITORY)
    private readonly clocks: SyncFieldClockRepository,
    @Inject(SYNC_PRODUCT_EDIT_LOCK) private readonly lock: ProductEditLock,
    @Inject(SYNC_CATALOG_GATEWAY) private readonly catalog: SyncCatalogGateway,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    @Inject(SYNC_CONFIG) private readonly config: SyncConfig,
    @Inject(SYNC_MONOTONIC) private readonly monotonic: Monotonic,
    private readonly serverClock: SyncClockService,
    private readonly requestContext: RequestContext,
  ) {}

  async push(ctx: PushContext, raw: unknown[]): Promise<SyncPushResponse> {
    const started = this.monotonic();
    const results: SyncOpResult[] = [];
    for (const [index, item] of raw.entries()) {
      // After the budget no new operation starts; the rest is reported and not recorded (FR-008).
      if (this.monotonic() - started >= this.config.pushBudgetMs) {
        results.push(retryResult(index, opIdOf(item), 'deadline_exceeded'));
        this.count(item, 'retry');
        continue;
      }
      results.push(await this.one(ctx, index, item));
    }
    const durationMs = this.monotonic() - started;
    offlinePushDuration.record(durationMs / 1_000);
    logPush({
      requestId: this.requestContext.requestId,
      shopId: ctx.shopId,
      deviceId: ctx.deviceId,
      ops: raw.length,
      durationMs: Math.round(durationMs),
    });
    return { results, serverHlc: this.serverClock.stamp() };
  }

  /**
   * Completes an operation that a request claimed and never finished (the recovery job). The caller has already taken
   * the claim over; the result is recorded exactly as a push would record it.
   */
  async completeClaimed(row: SyncOperationRow): Promise<void> {
    if (!row.content || !row.productId) {
      await this.ops.complete(
        row.shopId,
        row.opId,
        { status: 'rejected', code: 'invalid_op' },
        null,
        this.clock.now(),
      );
      return;
    }
    const op = opFromRecord({
      opId: row.opId,
      type: row.type,
      productId: row.productId,
      hlc: row.hlc,
      content: row.content,
    });
    const ctx: PushContext = {
      shopId: row.shopId,
      userId: row.userId ?? '',
      deviceId: row.deviceId,
    };
    const executed = await this.execute(ctx, op, row);
    if (executed.kind === 'done')
      await this.ops.complete(
        row.shopId,
        row.opId,
        executed.outcome,
        executed.conflict ?? null,
        this.clock.now(),
      );
  }

  // ---- one operation -----------------------------------------------------------------------------------------

  private async one(
    ctx: PushContext,
    index: number,
    raw: unknown,
  ): Promise<SyncOpResult> {
    const begun = this.monotonic();
    this.inFlight++;
    offlineOpsInFlightGauge.set(this.inFlight);
    try {
      const result = await this.decide(ctx, index, raw);
      this.count(raw, result.status);
      logOperation({
        requestId: this.requestContext.requestId,
        shopId: ctx.shopId,
        deviceId: ctx.deviceId,
        opId: result.opId,
        type: typeOf(raw),
        status: result.status,
        ...(result.code ? { code: result.code } : {}),
        durationMs: Math.round(this.monotonic() - begun),
      });
      return result;
    } catch (error) {
      // The catalog's own shop gate (suspended, offboarding) is an answer; anything else from a store is generic.
      if (error instanceof ShopNotActiveError) throw error;
      this.logger.error({
        action: 'catalog-sync.offline_push_failed',
        shopId: ctx.shopId,
        deviceId: ctx.deviceId,
        opId: opIdOf(raw),
        reason: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      });
      throw syncProblem('sync_unavailable', { retryAfterSeconds: 1 });
    } finally {
      this.inFlight--;
      offlineOpsInFlightGauge.set(this.inFlight);
    }
  }

  private async decide(
    ctx: PushContext,
    index: number,
    raw: unknown,
  ): Promise<SyncOpResult> {
    const parsed = parseOp(raw);
    if (!parsed.ok)
      return resultOf(
        index,
        opIdOf(raw),
        {
          status: 'rejected',
          code: 'invalid_op',
          detail: { issues: parsed.issues },
        },
        false,
      );
    const op = parsed.op;
    const now = this.clock.now();

    // Clock checks come before the claim: a clock that can be fixed is not remembered (the device re-stamps).
    const hlc = decodeHlc(op.hlc);
    const refused = !hlc
      ? 'invalid_hlc'
      : hlc.node !== ctx.deviceId
        ? 'hlc_node_mismatch'
        : expired(hlc, now.getTime(), this.config.maxOpAgeMs)
          ? 'op_expired'
          : op.type === 'product.update' &&
              !plausible(hlc, now.getTime(), this.config.clockDriftMs)
            ? 'clock_implausible'
            : null;
    if (refused)
      return resultOf(
        index,
        op.opId,
        { status: 'rejected', code: refused },
        false,
      );
    // Stock operations apply whatever their clock says, but a clock far ahead never moves the server's.
    if (hlc && plausible(hlc, now.getTime(), this.config.clockDriftMs))
      this.serverClock.accept(hlc);

    const fp = fingerprint(op);
    const claim = await this.ops.claim({
      shopId: ctx.shopId,
      opId: op.opId,
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      type: op.type,
      productId: op.productId,
      hlc: op.hlc,
      fingerprint: fp,
      content: payloadOf(op),
      now,
    });
    if (claim.kind === 'claimed') return this.run(ctx, index, op, null);

    const row = claim.row;
    if (row.fingerprint !== null && row.fingerprint !== fp)
      return resultOf(
        index,
        op.opId,
        { status: 'rejected', code: 'op_id_reused' },
        false,
      );
    if (row.status !== 'pending')
      return resultOf(index, op.opId, outcomeOf(row), true);

    const age = now.getTime() - row.claimedAt.getTime();
    if (age < this.config.claimLeaseMs) {
      // Probably another request, right now: wait for it instead of reporting a state it is about to leave.
      if (age < FRESH_CLAIM_MS) {
        const finished = await this.awaitCompletion(ctx.shopId, op.opId);
        if (finished)
          return resultOf(index, op.opId, outcomeOf(finished), true);
      }
      return retryResult(index, op.opId, 'in_flight');
    }
    const won = await this.ops.takeOver(
      ctx.shopId,
      op.opId,
      row.claimedAt,
      now,
    );
    if (!won) {
      const finished = await this.awaitCompletion(ctx.shopId, op.opId);
      return finished
        ? resultOf(index, op.opId, outcomeOf(finished), true)
        : retryResult(index, op.opId, 'in_flight');
    }
    return this.run(ctx, index, op, row);
  }

  /** Executes a claimed operation and records its result. `row` is set when this run took over an earlier claim. */
  private async run(
    ctx: PushContext,
    index: number,
    op: SyncOp,
    row: SyncOperationRow | null,
  ): Promise<SyncOpResult> {
    const executed = await this.execute(ctx, op, row);
    if (executed.kind === 'retry')
      return retryResult(index, op.opId, executed.code);
    const recorded = await this.ops.complete(
      ctx.shopId,
      op.opId,
      executed.outcome,
      executed.conflict ?? null,
      this.clock.now(),
    );
    if (recorded) return resultOf(index, op.opId, executed.outcome, false);
    // Someone else finished it first (a takeover raced us): the stored result is the truth.
    const stored = await this.ops.find(ctx.shopId, op.opId);
    return stored && stored.status !== 'pending'
      ? resultOf(index, op.opId, outcomeOf(stored), true)
      : retryResult(index, op.opId, 'in_flight');
  }

  private async awaitCompletion(
    shopId: string,
    opId: string,
  ): Promise<SyncOperationRow | null> {
    const until = Date.now() + IN_FLIGHT_WAIT_MS;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      const row = await this.ops.find(shopId, opId);
      if (row && row.status !== 'pending') return row;
    }
    return null;
  }

  private async execute(
    ctx: PushContext,
    op: SyncOp,
    row: SyncOperationRow | null,
  ): Promise<Executed> {
    return op.type === 'product.update'
      ? this.editFields(ctx, op, row)
      : this.changeStock(ctx, op, row);
  }

  // ---- stock -------------------------------------------------------------------------------------------------

  private async changeStock(
    ctx: PushContext,
    op: Extract<SyncOp, { type: 'stock.adjust' | 'stock.count' }>,
    row: SyncOperationRow | null,
  ): Promise<Executed> {
    const delta = stockDeltaOf(op);
    const reason =
      op.type === 'stock.adjust' ? `sync.${op.reason}` : 'sync.other';
    const operationId = `sync:${ctx.shopId}:${op.opId}`;
    const plan = (row?.detail as { plan?: { clampDelta?: number } } | null)
      ?.plan;

    // A decision made before a crash is repeated, never remade (the main call may fit now that stock moved).
    if (plan?.clampDelta !== undefined)
      return this.clampStock(
        ctx,
        op,
        delta,
        reason,
        operationId,
        plan.clampDelta,
      );

    if (delta >= 0) {
      // The catalog refuses only decreases on an archived product; the operation refuses any change to it.
      const view = await this.catalog.product(ctx.shopId, op.productId);
      if (!view) return rejection('unknown_product');
      if (view.status === 'ARCHIVED') return rejection('product_unavailable');
      if (delta === 0)
        return {
          kind: 'done',
          outcome: {
            status: 'applied',
            quantityAfter: view.quantity,
            productVersion: view.version,
            detail: { delta: 0 },
          },
        };
    }

    const result = await this.catalog.applyStock({
      operationId,
      shopId: ctx.shopId,
      productId: op.productId,
      delta,
      reason,
    });
    if (result.kind === 'applied')
      return {
        kind: 'done',
        outcome: {
          status: 'applied',
          quantityAfter: result.quantityAfter,
          productVersion: result.productVersion,
          detail: { delta },
        },
      };

    const decision = classifyCatalogFailure(result.code);
    if (decision.result === 'rejected') return rejection(decision.code);
    if (decision.result === 'conflict') {
      const view = await this.catalog.product(ctx.shopId, op.productId);
      return this.conflictOf(ctx, op, delta, {
        kind: 'quantity_limit',
        applied: 0,
        shortfall: delta,
        quantityAfter: view?.quantity ?? 0,
        productVersion: view?.version,
      });
    }
    return this.clampStock(ctx, op, delta, reason, operationId, undefined);
  }

  /**
   * An oversold delta: the part that keeps stock at or above zero is applied by a second catalog command, the rest is
   * the shortfall of an `oversold` conflict. The decision is saved on the pending row before the command is sent.
   */
  private async clampStock(
    ctx: PushContext,
    op: SyncOp,
    delta: number,
    reason: string,
    operationId: string,
    planned: number | undefined,
  ): Promise<Executed> {
    let appliedDelta = planned;
    for (let attempt = 0; attempt < CLAMP_ATTEMPTS; attempt++) {
      if (appliedDelta === undefined) {
        const view = await this.catalog.product(ctx.shopId, op.productId);
        if (!view) return rejection('unknown_product');
        if (view.status === 'ARCHIVED') return rejection('product_unavailable');
        const clamp = clampDelta(delta, view.quantity);
        if (clamp.applied === 0)
          return this.conflictOf(ctx, op, delta, {
            kind: 'oversold',
            applied: 0,
            shortfall: clamp.shortfall,
            quantityAfter: view.quantity,
            productVersion: view.version,
          });
        appliedDelta = clamp.applied;
        await this.ops.savePlan(ctx.shopId, op.opId, {
          plan: { clampDelta: appliedDelta },
        });
      }
      const result = await this.catalog.applyStock({
        operationId: `${operationId}:clamp`,
        shopId: ctx.shopId,
        productId: op.productId,
        delta: appliedDelta,
        reason,
      });
      if (result.kind === 'applied')
        return this.conflictOf(ctx, op, delta, {
          kind: 'oversold',
          applied: appliedDelta,
          shortfall: Math.abs(delta - appliedDelta),
          quantityAfter: result.quantityAfter,
          productVersion: result.productVersion,
        });
      const decision = classifyCatalogFailure(result.code);
      if (decision.result === 'rejected') return rejection(decision.code);
      // Stock moved between the read and the command: read again and decide again.
      appliedDelta = undefined;
    }
    return { kind: 'retry', code: 'contention' };
  }

  private conflictOf(
    ctx: PushContext,
    op: SyncOp,
    requested: number,
    c: {
      kind: 'oversold' | 'quantity_limit';
      applied: number;
      shortfall: number;
      quantityAfter: number;
      productVersion?: number;
    },
  ): Executed {
    const numbers = {
      kind: c.kind,
      requested,
      applied: c.applied,
      shortfall: c.shortfall,
    };
    const conflict: ConflictInput = {
      deviceId: ctx.deviceId,
      productId: op.productId,
      ...numbers,
      quantityAfter: c.quantityAfter,
    };
    return {
      kind: 'done',
      outcome: {
        status: 'conflict',
        quantityAfter: c.quantityAfter,
        ...(c.productVersion !== undefined
          ? { productVersion: c.productVersion }
          : {}),
        detail: { delta: requested, conflict: numbers },
      },
      conflict,
    };
  }

  // ---- fields ------------------------------------------------------------------------------------------------

  private async editFields(
    ctx: PushContext,
    op: Extract<SyncOp, { type: 'product.update' }>,
    row: SyncOperationRow | null,
  ): Promise<Executed> {
    const locked = await this.lock.withLock(
      ctx.shopId,
      op.productId,
      EDIT_LOCK_WAIT_MS,
      () => this.decideAndWrite(ctx, op, row),
    );
    return locked.kind === 'locked'
      ? locked.value
      : { kind: 'retry', code: 'contention' };
  }

  /** Under the product's edit lock: read the clocks, decide per field, write through the catalog, advance the clocks. */
  private async decideAndWrite(
    ctx: PushContext,
    op: Extract<SyncOp, { type: 'product.update' }>,
    row: SyncOperationRow | null,
  ): Promise<Executed> {
    const names = Object.keys(op.fields) as SyncField[];
    for (let attempt = 0; attempt < FIELD_ATTEMPTS; attempt++) {
      const view = await this.catalog.product(ctx.shopId, op.productId);
      if (!view) return rejection('unknown_product');
      if (view.status === 'ARCHIVED') return rejection('product_unavailable');

      const stored = await this.clocks.read(ctx.shopId, op.productId);
      // A taken-over run meets the clocks its own earlier run wrote: those fields are already applied.
      const done = row ? names.filter((name) => stored[name] === op.hlc) : [];
      const { win, lose } = decideFields(
        names.filter((name) => !done.includes(name)),
        op.hlc,
        stored,
      );
      const finish = (version: number): Executed => ({
        kind: 'done',
        outcome: {
          status: lose.length === 0 ? 'applied' : 'merged',
          productVersion: version,
          detail: {
            applied: [...done, ...win],
            superseded: lose,
          },
        },
      });
      if (win.length === 0) return finish(view.version);

      const written = await this.catalog.updateFields(
        ctx.shopId,
        op.productId,
        view.version,
        Object.fromEntries(win.map((name) => [name, op.fields[name]!])),
        ctx.userId || null,
      );
      switch (written.kind) {
        case 'updated':
          await this.clocks.advance(
            ctx.shopId,
            op.productId,
            Object.fromEntries(win.map((name) => [name, op.hlc])),
          );
          return finish(written.version);
        case 'version_conflict':
          continue;
        case 'invalid':
          return rejection('invalid_field', { fields: written.fields });
        case 'archived':
          return rejection('product_unavailable');
        case 'not_found':
          return rejection('unknown_product');
      }
    }
    return { kind: 'retry', code: 'contention' };
  }

  // ---- metrics -----------------------------------------------------------------------------------------------

  private count(raw: unknown, status: string): void {
    offlineOpsCounter.add(1, { type: typeOf(raw), status });
  }
}

const TYPES = new Set(['stock.adjust', 'stock.count', 'product.update']);
const typeOf = (raw: unknown): string => {
  const type =
    typeof raw === 'object' && raw !== null
      ? (raw as { type?: unknown }).type
      : undefined;
  return typeof type === 'string' && TYPES.has(type) ? type : 'invalid';
};
