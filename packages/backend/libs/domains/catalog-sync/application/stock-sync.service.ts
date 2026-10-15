import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import type { StockCandidate } from '../domain/ports/records';
import { merge, type MergeConflict } from '../domain/stock-merge';
import {
  CATALOG_GATEWAY,
  CONFLICT_REPOSITORY,
  LINK_REPOSITORY,
  PROVIDER_SESSIONS,
  SYNC_CLOCK,
  type CatalogGateway,
  type Clock,
  type ConflictRepository,
  type IntegrationRecord,
  type LinkRecord,
  type LinkRepository,
  type ProviderSessions,
  type StockDeltaOp,
} from '../domain/ports';
import { StockConflictOpened } from './events/integration-events';
import { PRODUCT_ENTITY } from './integration-view.service';
import { LinkApplyService } from './link-apply.service';
import { echoSuppressedCounter } from './sync-metrics';

export type { StockCandidate };

/** The local product as the stock merge needs it. */
export interface LocalStock {
  quantity: number;
  version: number;
}

type Inbound =
  | { kind: 'applied'; local: LocalStock }
  /** The link is gone or the local product no longer exists: nothing more to do. */
  | { kind: 'stop' };

/** `StockDeltaOp.delta` is limited to +-1,000,000 per operation (S05). */
const MAX_OP_DELTA = 1_000_000;
/** S05 takes at most this many operations per call. */
const OPS_PER_CALL = 100;
const READ_BATCH = 500;

const digest = (...parts: Array<string | number>) =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);

/**
 * The stock side of the sync (FR-040 - FR-046, AS-35 - AS-44). Per variant it keeps a base `B` (`syncedStock`, the value
 * both sides last agreed on) and merges `L + R - B`:
 *  - inbound: the provider's change `R - B` is a delta through the catalog's stock command with a deterministic
 *    operation id, so a crash between the command and the bookkeeping replays the same command (`replayed: true`);
 *  - outbound: the local quantity is written to the provider as an absolute set, conditional on the provider still
 *    holding the value we last saw. A refused write is abandoned (never overwrites the seller's sale); the merge then runs
 *    again from the provider's fresh state.
 * The catalog is only reached through `CatalogGateway`: no `Product` SQL, no product event is appended here.
 */
@Injectable()
export class StockSyncService {
  private readonly logger = new Logger(StockSyncService.name);

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly apply: LinkApplyService,
    @Inject(CATALOG_GATEWAY) private readonly catalog: CatalogGateway,
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(CONFLICT_REPOSITORY) private readonly conflicts: ConflictRepository,
    @Inject(PROVIDER_SESSIONS) private readonly sessions: ProviderSessions,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Pull side: merges the stock of the variants of one fetched page. `fetchedAt` is when the page was requested: a variant
   * whose stock we wrote after that moment is skipped, its page value is older than our write (AS-41). Provider failures
   * propagate so the run ends `failed` (AS-43).
   */
  async mergePage(
    integration: IntegrationRecord,
    candidates: StockCandidate[],
    fetchedAt: Date,
  ): Promise<void> {
    if (candidates.length === 0) return;
    const fresh = await this.links.findMany(
      integration.id,
      candidates.map((c) => c.externalId),
      PRODUCT_ENTITY,
    );
    const eligible: Array<{ candidate: StockCandidate; link: LinkRecord }> = [];
    for (const candidate of candidates) {
      const link = fresh.get(candidate.externalId);
      if (!link || link.state !== 'ACTIVE') continue;
      if (link.lastStockWriteAt && link.lastStockWriteAt > fetchedAt) continue;
      eligible.push({ candidate, link });
    }

    const locals = new Map<string, LocalStock>();
    for (let i = 0; i < eligible.length; i += READ_BATCH) {
      const found = await this.catalog.getProducts(
        integration.shopId,
        eligible.slice(i, i + READ_BATCH).map((e) => e.link.localId),
      );
      for (const [id, p] of found)
        locals.set(id, { quantity: p.quantity, version: p.version });
    }

    for (const { candidate, link } of eligible) {
      const local = locals.get(link.localId);
      if (!local) continue;
      const base = link.syncedStock ?? candidate.stock;
      if (
        link.syncedStock !== null &&
        candidate.stock === base &&
        local.quantity === base
      )
        continue;
      await this.converge(integration, link, candidate, local);
    }
  }

  /**
   * Push side: the event of a local change carries the product's quantity and version. At most one conditional write
   * "set <quantity> expected <syncedStock>"; an older or repeated version, an echo of our own apply (quantity equals the
   * base) and a link that is not live do nothing. Provider failures propagate to the caller.
   */
  async pushLocal(
    integration: IntegrationRecord,
    link: LinkRecord,
    local: LocalStock,
  ): Promise<void> {
    if (link.state !== 'ACTIVE' || link.syncedStock === null) return;
    if (
      link.lastLocalVersion !== null &&
      local.version <= link.lastLocalVersion
    )
      return;
    if (local.quantity === link.syncedStock) {
      echoSuppressedCounter.add(1);
      return;
    }

    const session = this.sessions.forIntegration(integration);
    const provider = this.sessions.provider(integration.provider);
    const outcome = await provider.setStock(
      session,
      link.externalId,
      local.quantity,
      link.syncedStock,
    );
    if (outcome === 'accepted') {
      await this.links.recordStock(
        integration.id,
        link.externalId,
        {
          syncedStock: local.quantity,
          lastStockWriteAt: this.clock.now(),
          lastLocalVersion: local.version,
        },
        PRODUCT_ENTITY,
      );
      return;
    }
    if (outcome === 'gone') {
      await this.apply.markDeleted(integration, link.externalId);
      return;
    }
    // The provider no longer holds the value we last saw: the seller sold too. Merge from the provider's current state.
    const remote = await this.readRemote(integration, link);
    if (remote === 'gone') {
      await this.apply.markDeleted(integration, link.externalId);
      return;
    }
    if (remote === null) return;
    const current = (
      await this.links.findMany(
        integration.id,
        [link.externalId],
        PRODUCT_ENTITY,
      )
    ).get(link.externalId);
    if (!current || current.state !== 'ACTIVE') return;
    await this.converge(integration, current, remote, undefined);
  }

  // ---- merge --------------------------------------------------------------------------------------------------

  /** Brings local, provider and base together for one variant whose provider state is `remote`. */
  async converge(
    integration: IntegrationRecord,
    link: LinkRecord,
    remote: StockCandidate,
    known: LocalStock | undefined,
  ): Promise<void> {
    const base = link.syncedStock ?? remote.stock;
    let local: LocalStock;
    if (remote.stock !== base) {
      const inbound = await this.inbound(integration, link, base, remote);
      if (inbound.kind === 'stop') return;
      local = inbound.local;
    } else {
      const read = known ?? (await this.readLocal(integration, link.localId));
      if (!read) return;
      local = read;
    }

    if (local.quantity === remote.stock) {
      if (link.syncedStock !== remote.stock)
        await this.record(integration, link, remote.stock, local.version);
      return;
    }

    const provider = this.sessions.provider(integration.provider);
    const outcome = await provider.setStock(
      this.sessions.forIntegration(integration),
      link.externalId,
      local.quantity,
      remote.stock,
    );
    if (outcome === 'accepted') {
      await this.record(integration, link, local.quantity, local.version);
    } else if (outcome === 'gone') {
      await this.apply.markDeleted(integration, link.externalId);
    } else if (remote.stock !== base) {
      // Refused: the provider moved again. The local side already includes the change we read, so the base follows it;
      // the push is retried by the next pull, event or reconciliation. It is never forced.
      await this.record(integration, link, remote.stock, local.version);
    }
  }

  /**
   * The provider changed from `base` to `remote.stock`: the local quantity changes by the same delta, whatever the local
   * side did meanwhile. Oversold / over the cap: both sides are set to the clamped value and a conflict is opened.
   */
  private async inbound(
    integration: IntegrationRecord,
    link: LinkRecord,
    base: number,
    remote: StockCandidate,
  ): Promise<Inbound> {
    const operationId = `sync:${integration.id}:${digest(link.externalId, base, remote.stock, remote.updatedAt.toISOString())}`;
    const result = await this.applyLocal(
      integration,
      link.localId,
      operationId,
      remote.stock - base,
    );

    if (result.kind === 'applied') {
      // A replay answers with what the first apply saw: read the product as it is now.
      const local = result.replayed
        ? await this.readLocal(integration, link.localId)
        : result.local;
      return local ? { kind: 'applied', local } : { kind: 'stop' };
    }
    if (result.kind === 'operation_conflict') {
      const local = await this.readLocal(integration, link.localId);
      return local ? { kind: 'applied', local } : { kind: 'stop' };
    }
    if (result.code === 'not_found') {
      await this.links.markState(
        integration.id,
        link.externalId,
        'IGNORED',
        undefined,
        PRODUCT_ENTITY,
      );
      return { kind: 'stop' };
    }
    if (result.code === 'unavailable')
      throw new Error('catalog stock command unavailable');

    // insufficient_stock / quantity_limit
    const current = await this.readLocal(integration, link.localId);
    if (!current) return { kind: 'stop' };
    const plan = merge(base, current.quantity, remote.stock);
    if (!plan.conflict)
      throw new Error('catalog refused a stock change the merge accepts');
    if (plan.localDelta !== 0) {
      const fix = await this.applyLocal(
        integration,
        link.localId,
        `${operationId}:c`,
        plan.localDelta,
      );
      if (fix.kind === 'rejected')
        throw new Error(`stock clamp refused: ${fix.code}`);
    }
    await this.openConflict(
      integration,
      link,
      plan.conflict,
      base,
      current.quantity,
      remote.stock,
      plan.result,
    );
    const local = await this.readLocal(integration, link.localId);
    return local ? { kind: 'applied', local } : { kind: 'stop' };
  }

  /** `sync-inbound` delta in chunks of at most 1,000,000 (ids `<id>:<n>` when chunked), at most 100 operations per call. */
  private async applyLocal(
    integration: IntegrationRecord,
    productId: string,
    operationId: string,
    delta: number,
  ): Promise<
    | { kind: 'applied'; replayed: boolean; local: LocalStock }
    | { kind: 'operation_conflict' }
    | {
        kind: 'rejected';
        code:
          'insufficient_stock' | 'unavailable' | 'not_found' | 'quantity_limit';
      }
  > {
    const ops: StockDeltaOp[] = [];
    const sign = delta < 0 ? -1 : 1;
    const chunks = Math.ceil(Math.abs(delta) / MAX_OP_DELTA);
    for (let i = 0; i < chunks; i++) {
      const part = Math.min(MAX_OP_DELTA, Math.abs(delta) - i * MAX_OP_DELTA);
      ops.push({
        operationId: chunks === 1 ? operationId : `${operationId}:${i}`,
        productId,
        shopId: integration.shopId,
        delta: sign * part,
        reason: 'sync-inbound',
      });
    }

    let replayed = true;
    let last: { quantityAfter: number; productVersion: number } | undefined;
    for (let i = 0; i < ops.length; i += OPS_PER_CALL) {
      const outcome = await this.catalog.applyStockDelta(
        ops.slice(i, i + OPS_PER_CALL),
      );
      if (outcome.kind === 'operation_conflict')
        return { kind: 'operation_conflict' };
      if (outcome.kind === 'rejected')
        return { kind: 'rejected', code: outcome.failures[0].code };
      for (const r of outcome.results) {
        replayed = replayed && r.replayed;
        last = r;
      }
    }
    return {
      kind: 'applied',
      replayed,
      local: { quantity: last!.quantityAfter, version: last!.productVersion },
    };
  }

  private async openConflict(
    integration: IntegrationRecord,
    link: LinkRecord,
    kind: MergeConflict,
    base: number,
    local: number,
    remote: number,
    resolvedTo: number,
  ): Promise<void> {
    const now = this.clock.now();
    await this.transactions.run(async () => {
      const { conflict, created } = await this.conflicts.open(
        {
          integrationId: integration.id,
          shopId: integration.shopId,
          externalId: link.externalId,
          productId: link.localId,
          kind,
          base,
          local,
          remote,
          merged: local + remote - base,
          resolvedTo,
        },
        now,
      );
      if (created)
        await this.outbox.append(
          StockConflictOpened.create(
            integration.id,
            0,
            {
              conflictId: conflict.id,
              integrationId: integration.id,
              shopId: integration.shopId,
              productId: link.localId,
              kind,
              base,
              local,
              remote,
              resolvedTo,
            },
            now,
          ),
        );
    });
  }

  // ---- reads and bookkeeping ----------------------------------------------------------------------------------

  private async readLocal(
    integration: IntegrationRecord,
    productId: string,
  ): Promise<LocalStock | undefined> {
    const found = (
      await this.catalog.getProducts(integration.shopId, [productId])
    ).get(productId);
    return found
      ? { quantity: found.quantity, version: found.version }
      : undefined;
  }

  /** Direct read of one variant: its stock and `updatedAt`; `'gone'` = the provider answered "not found"; `null` = unusable. */
  async readRemote(
    integration: IntegrationRecord,
    link: LinkRecord,
  ): Promise<StockCandidate | 'gone' | null> {
    const raw = await this.sessions
      .provider(integration.provider)
      .fetchOne(this.sessions.forIntegration(integration), link.externalId);
    if (!raw) return 'gone';
    for (const result of raw.results)
      if (result.ok && result.item.externalId === link.externalId)
        return {
          externalId: link.externalId,
          stock: result.item.stock,
          updatedAt: result.item.updatedAt,
        };
    this.logger.warn({
      action: 'catalog-sync.stock_read_unusable',
      integrationId: integration.id,
      shopId: integration.shopId,
    });
    return null;
  }

  private async record(
    integration: IntegrationRecord,
    link: LinkRecord,
    syncedStock: number,
    version: number,
  ) {
    await this.links.recordStock(
      integration.id,
      link.externalId,
      {
        syncedStock,
        lastStockWriteAt: this.clock.now(),
        lastLocalVersion: version,
      },
      PRODUCT_ENTITY,
    );
  }
}
