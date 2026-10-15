import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  ReconciliationPage,
  ReconciliationReport,
} from '@marketplace-sandbox/contracts';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import { syncProblem } from '../domain/catalog-sync-errors';
import {
  classifyReconciliation,
  massDeleteGuard,
  type Finding,
  type LocalLink,
  type RemoteItem,
} from '../domain/reconcile-classify';
import {
  CATALOG_GATEWAY,
  CURSOR_REPOSITORY,
  INTEGRATION_BACKFILL_QUEUE,
  INTEGRATION_REPOSITORY,
  INTEGRATION_SYNC_QUEUE,
  LINK_REPOSITORY,
  PROVIDER_SESSIONS,
  ProviderCallError,
  RECONCILIATION_REPOSITORY,
  RUN_REPOSITORY,
  SHOP_STATUS_GATEWAY,
  SYNC_CLOCK,
  SYNC_QUEUE,
  type CatalogGateway,
  type Clock,
  type CursorRepository,
  type IntegrationRecord,
  type IntegrationRepository,
  type LinkRecord,
  type LinkRepository,
  type ProviderSessions,
  type RawItem,
  type ReconciliationFinding,
  type ReconciliationOutcome,
  type ReconciliationRecord,
  type ReconciliationRepository,
  type RemoteDigest,
  type RunRepository,
  type ShopStatusGateway,
  type SyncQueue,
  type SyncRunOutcome,
} from '../domain/ports';
import {
  IntegrationAttentionRequired,
  ReconciliationCompleted,
} from './events/integration-events';
import { IntegrationHealthService } from './integration-health.service';
import { PRODUCT_ENTITY } from './integration-view.service';
import { LinkApplyService } from './link-apply.service';
import { StockSyncService, type LocalStock } from './stock-sync.service';
import { reconcileFindingsCounter, syncRunsCounter } from './sync-metrics';

/** Cursor entity that holds the run's lease: one reconciliation per integration at a time. */
export const RECONCILE_ENTITY = 'reconcile';
const LEASE_TTL_MS = 15 * 60_000;
const LINK_PAGE = 500;
const READ_BATCH = 500;
/** Direct provider reads per kind of fix in one run; the rest is left to the next run (the findings stay visible). */
const MAX_DIRECT_READS = 500;
/** More unknown provider variants than this are not queued one by one: a single backfill pulls them all. */
const MAX_PULL_MESSAGES = 1_000;

type Kind = ReconciliationFinding['kind'];

/** A finding while the run works on it. */
interface Work {
  kind: Kind;
  externalId: string;
  needsReview: boolean;
  fixed: boolean;
  detail?: string;
  link?: LinkRecord;
  local?: LocalStock;
}

interface Progress {
  counts: Record<string, number>;
  work: Work[];
}

const emptyCounts = (): Record<string, number> => ({
  linked: 0,
  remote: 0,
  matched: 0,
  missingAtProvider: 0,
  missingLocally: 0,
  contentDrift: 0,
  stockDrift: 0,
  autoFixed: 0,
  needsReview: 0,
});

const keyOf = (f: { kind: string; externalId: string | null }) =>
  `${f.kind}:${f.externalId}`;

/**
 * Nightly and on-demand reconciliation of one integration (FR-060 - FR-063, AS-61 - AS-65). The complete provider
 * listing of ids and digests is compared with the links in keyset pages; deletions are never inferred from a listing
 * that may be partial (a failed page ends the run `failed` before any comparison), are confirmed by a direct read, and a
 * mass-deletion guard stops a run whose listing lost a fifth of the links. Only clearly safe fixes are applied, through
 * the same code as live sync. The report is immutable once the run ends (the store refuses updates).
 */
@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(CURSOR_REPOSITORY) private readonly cursors: CursorRepository,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RECONCILIATION_REPOSITORY)
    private readonly reports: ReconciliationRepository,
    @Inject(CATALOG_GATEWAY) private readonly catalog: CatalogGateway,
    @Inject(PROVIDER_SESSIONS) private readonly sessions: ProviderSessions,
    @Inject(SHOP_STATUS_GATEWAY) private readonly shops: ShopStatusGateway,
    @Inject(SYNC_QUEUE) private readonly queue: SyncQueue,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly apply: LinkApplyService,
    private readonly stock: StockSyncService,
    private readonly health: IntegrationHealthService,
    private readonly limiter: RateLimiterService,
  ) {}

  // ---- the run ------------------------------------------------------------------------------------------------

  async run(integration: IntegrationRecord): Promise<SyncRunOutcome> {
    const startedAt = this.clock.now();
    const shop = (await this.shops.getStatuses([integration.shopId])).get(
      integration.shopId,
    );
    if (!shop || shop.status !== 'ACTIVE')
      return this.recordSkipped(integration, 'skipped_shop_not_active');

    const holder = randomUUID();
    const fence = await this.cursors.claimLease(
      integration.id,
      RECONCILE_ENTITY,
      holder,
      LEASE_TTL_MS,
      startedAt,
    );
    if (fence === null)
      return this.recordSkipped(integration, 'skipped_locked');

    try {
      const previous = await this.reports.findLatestFinished(integration.id);
      const runId = await this.reports.start(
        integration.id,
        startedAt,
        previous?.id ?? null,
      );
      const syncRunId = await this.runs.start(
        integration.id,
        'reconcile',
        startedAt,
      );
      const progress: Progress = { counts: emptyCounts(), work: [] };
      let outcome: ReconciliationOutcome;
      let failure: string | undefined;
      try {
        outcome = await this.execute(integration, progress);
      } catch (error) {
        outcome = 'failed';
        failure =
          error instanceof ProviderCallError ? error.kind : 'internal_error';
        if (error instanceof ProviderCallError) {
          if (error.kind === 'auth_failed')
            await this.health.markNeedsReauth(integration);
        } else {
          this.logger.error({
            action: 'catalog-sync.reconcile_failed',
            integrationId: integration.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const now = this.clock.now();
      const findings = this.report(progress.work, previous);
      const counts = this.finalCounts(progress);
      await this.transactions.run(async () => {
        if (
          !(await this.reports.finish(
            runId,
            { outcome, counts, findings },
            now,
          ))
        )
          return;
        const events: Array<
          | ReturnType<typeof ReconciliationCompleted.create>
          | ReturnType<typeof IntegrationAttentionRequired.create>
        > = [
          ReconciliationCompleted.create(
            integration.id,
            0,
            {
              integrationId: integration.id,
              shopId: integration.shopId,
              runId,
              outcome,
              counts,
            },
            now,
          ),
        ];
        if (outcome === 'aborted_mass_delete')
          events.push(
            IntegrationAttentionRequired.create(
              integration.id,
              0,
              {
                integrationId: integration.id,
                shopId: integration.shopId,
                reason: 'reconcile_mass_delete',
                detail: `The provider listing is missing ${counts.missingAtProvider} of ${counts.linked} linked variants; nothing was changed.`,
              },
              now,
            ),
          );
        await this.outbox.append(events);
      });
      for (const f of findings)
        if (f.outcome !== 'fixed')
          reconcileFindingsCounter.add(1, { kind: f.kind });

      const syncOutcome: SyncRunOutcome =
        outcome === 'completed' ? 'completed' : 'failed';
      await this.runs.finish(
        syncRunId,
        {
          outcome: syncOutcome,
          counters: { fetched: counts.remote },
          detail: outcome === 'completed' ? null : (failure ?? outcome),
        },
        now,
      );
      syncRunsCounter.add(1, {
        provider: integration.provider,
        kind: 'reconcile',
        outcome: syncOutcome,
      });
      this.logger.log({
        action: 'catalog-sync.reconcile_finished',
        integrationId: integration.id,
        shopId: integration.shopId,
        runId,
        outcome,
      });
      return syncOutcome;
    } finally {
      await this.cursors
        .releaseLease(integration.id, RECONCILE_ENTITY, holder, fence)
        .catch(() => undefined);
    }
  }

  private async execute(
    integration: IntegrationRecord,
    progress: Progress,
  ): Promise<ReconciliationOutcome> {
    const session = this.sessions.forIntegration(integration);
    const provider = this.sessions.provider(integration.provider);

    // The whole listing first: a page that fails ends the run here, before any set difference exists.
    const remote = new Map<string, RemoteDigest>();
    let pageCursor: string | null = null;
    do {
      const page = await provider.listAllIdsAndDigests(session, { pageCursor });
      for (const item of page.items) remote.set(item.externalId, item);
      pageCursor = page.nextCursor;
    } while (pageCursor !== null);

    await this.classify(integration, remote, progress);
    const { counts } = progress;
    if (massDeleteGuard(counts.linked, counts.missingAtProvider))
      return 'aborted_mass_delete';

    // Fixes. Each group re-checks that the integration is still ACTIVE: a disconnect or pause stops the run.
    if (!(await this.stillActive(integration))) return 'failed';
    await this.confirmDeletions(integration, progress);
    if (!(await this.stillActive(integration))) return 'failed';
    await this.fixContent(integration, progress);
    if (!(await this.stillActive(integration))) return 'failed';
    await this.fixStock(integration, progress);
    if (!(await this.stillActive(integration))) return 'failed';
    await this.fixUnlinked(integration, progress);
    return 'completed';
  }

  /** Comparison in keyset pages of links; the local quantities of one page come from one batch read. */
  private async classify(
    integration: IntegrationRecord,
    remote: Map<string, RemoteDigest>,
    progress: Progress,
  ): Promise<void> {
    const { counts, work } = progress;
    counts.remote = remote.size;
    const linkedIds = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page = await this.links.pageForReconcile(
        integration.id,
        after,
        LINK_PAGE,
      );
      if (page.length === 0) break;
      after = page[page.length - 1].externalId;
      const active = page.filter((l) => l.state === 'ACTIVE');
      const locals = await this.readLocals(integration, active);
      const byId = new Map(active.map((l) => [l.externalId, l]));
      for (const l of active) linkedIds.add(l.externalId);

      const asLocal: LocalLink[] = active.map((l) => {
        const local = locals.get(l.localId);
        return {
          externalId: l.externalId,
          contentDigest: l.contentDigest ?? '',
          syncedStock: l.syncedStock ?? Number.NaN,
          ...(local ? { localQuantity: local.quantity } : {}),
        };
      });
      const listed: RemoteItem[] = [];
      for (const l of active) {
        const r = remote.get(l.externalId);
        if (r)
          listed.push({
            externalId: r.externalId,
            digest: r.digest,
            stock: r.stock,
          });
      }
      const out = classifyReconciliation(asLocal, listed);
      counts.linked += out.counts.linked;
      counts.matched += out.counts.matched;
      counts.missingAtProvider += out.counts.missingAtProvider;
      counts.contentDrift += out.counts.contentDrift;
      counts.stockDrift += out.counts.stockDrift;
      for (const f of out.findings as Finding[]) {
        const link = byId.get(f.externalId);
        work.push({
          kind: f.kind,
          externalId: f.externalId,
          needsReview: f.needsReview,
          fixed: false,
          link,
          local: link ? locals.get(link.localId) : undefined,
        });
      }
    }

    // Provider variants without a live link: not linked yet, relisted after a deletion, or ignored on purpose.
    const candidates = [...remote.keys()]
      .filter((id) => !linkedIds.has(id))
      .sort();
    for (let i = 0; i < candidates.length; i += READ_BATCH) {
      const chunk = candidates.slice(i, i + READ_BATCH);
      const known = await this.links.findMany(
        integration.id,
        chunk,
        PRODUCT_ENTITY,
      );
      for (const id of chunk) {
        const link = known.get(id);
        if (link?.state === 'IGNORED') continue;
        counts.missingLocally++;
        work.push({
          kind: 'missing_locally',
          externalId: id,
          needsReview: false,
          fixed: false,
          link,
        });
      }
    }
  }

  private async readLocals(
    integration: IntegrationRecord,
    links: LinkRecord[],
  ): Promise<Map<string, LocalStock>> {
    const locals = new Map<string, LocalStock>();
    for (let i = 0; i < links.length; i += READ_BATCH) {
      const found = await this.catalog.getProducts(
        integration.shopId,
        links.slice(i, i + READ_BATCH).map((l) => l.localId),
      );
      for (const [id, p] of found)
        locals.set(id, { quantity: p.quantity, version: p.version });
    }
    return locals;
  }

  private async stillActive(integration: IntegrationRecord): Promise<boolean> {
    return (
      (await this.integrations.findById(integration.id))?.status === 'ACTIVE'
    );
  }

  /** Absent from the listing: a direct read decides. `404` confirms; a variant the provider still returns is not touched. */
  private async confirmDeletions(
    integration: IntegrationRecord,
    progress: Progress,
  ): Promise<void> {
    const session = this.sessions.forIntegration(integration);
    const provider = this.sessions.provider(integration.provider);
    let reads = 0;
    for (const w of progress.work) {
      if (w.kind !== 'missing_at_provider') continue;
      if (reads++ >= MAX_DIRECT_READS) break;
      const raw = await provider.fetchOne(session, w.externalId);
      if (raw && presentIn(raw, w.externalId)) {
        w.kind = 'list_inconsistent';
        progress.counts.missingAtProvider--;
        progress.counts.listInconsistent =
          (progress.counts.listInconsistent ?? 0) + 1;
        continue;
      }
      w.fixed = (await this.apply.markDeleted(integration, w.externalId)) > 0;
    }
  }

  /** A changed digest: the item is fetched and applied like a page item (stale items stay open). */
  private async fixContent(
    integration: IntegrationRecord,
    progress: Progress,
  ): Promise<void> {
    const session = this.sessions.forIntegration(integration);
    const provider = this.sessions.provider(integration.provider);
    let reads = 0;
    for (const w of progress.work) {
      if (w.kind !== 'content_drift') continue;
      if (reads++ >= MAX_DIRECT_READS) break;
      w.fixed = await this.applyFetched(
        integration,
        provider,
        session,
        w.externalId,
        w,
      );
    }
  }

  private async applyFetched(
    integration: IntegrationRecord,
    provider: ReturnType<ProviderSessions['provider']>,
    session: ReturnType<ProviderSessions['forIntegration']>,
    externalId: string,
    w: Work,
  ): Promise<boolean> {
    const fetchedAt = this.clock.now();
    const raw = await provider.fetchOne(session, externalId);
    if (!raw || !presentIn(raw, externalId)) {
      w.detail = 'gone_at_provider';
      return false;
    }
    const applied = await this.apply.applyItems(integration, [raw]);
    if (applied.kind === 'shop_not_active') return false;
    if (applied.counters.stale > 0) {
      w.detail = 'stale';
      return false;
    }
    if (applied.counters.quarantined > 0) {
      w.detail = 'quarantined';
      return false;
    }
    await this.stock.mergePage(integration, applied.stock, fetchedAt);
    return true;
  }

  /** Stock drift: the live-sync merge rule decides (exactly one side moved: apply it; both: merge or open a conflict). */
  private async fixStock(
    integration: IntegrationRecord,
    progress: Progress,
  ): Promise<void> {
    let reads = 0;
    for (const w of progress.work) {
      if (w.kind !== 'stock_drift' || !w.link) continue;
      if (reads++ >= MAX_DIRECT_READS) break;
      const remote = await this.stock.readRemote(integration, w.link);
      if (remote === 'gone') {
        await this.apply.markDeleted(integration, w.externalId);
        w.detail = 'gone_at_provider';
        continue;
      }
      if (remote === null) continue;
      await this.stock.converge(integration, w.link, remote, w.local);
      w.fixed = !w.needsReview;
      if (w.needsReview) w.detail = 'conflict';
    }
  }

  /** Provider variants without a live link: relisted ones are re-applied, new ones are queued for a normal pull. */
  private async fixUnlinked(
    integration: IntegrationRecord,
    progress: Progress,
  ): Promise<void> {
    const session = this.sessions.forIntegration(integration);
    const provider = this.sessions.provider(integration.provider);
    const unlinked = progress.work.filter((w) => w.kind === 'missing_locally');
    const relisted = unlinked.filter(
      (w) => w.link && w.link.state !== 'ACTIVE',
    );
    const fresh = unlinked.filter((w) => !w.link);
    let reads = 0;
    for (const w of relisted) {
      if (reads++ >= MAX_DIRECT_READS) break;
      w.fixed = await this.applyFetched(
        integration,
        provider,
        session,
        w.externalId,
        w,
      );
      if (w.fixed) w.detail = 'relisted';
    }
    if (fresh.length > MAX_PULL_MESSAGES) {
      // Too many for one message each: one backfill brings them all in.
      if (
        await this.tryEnqueue(INTEGRATION_BACKFILL_QUEUE, {
          integrationId: integration.id,
          kind: 'backfill',
        })
      )
        for (const w of fresh) {
          w.fixed = true;
          w.detail = 'backfill_queued';
        }
      return;
    }
    for (const w of fresh)
      if (
        await this.tryEnqueue(INTEGRATION_SYNC_QUEUE, {
          integrationId: integration.id,
          kind: 'one',
          externalId: w.externalId,
        })
      ) {
        w.fixed = true;
        w.detail = 'queued_for_pull';
      }
  }

  private async tryEnqueue(
    queue: typeof INTEGRATION_SYNC_QUEUE | typeof INTEGRATION_BACKFILL_QUEUE,
    message: Parameters<SyncQueue['enqueue']>[1],
  ): Promise<boolean> {
    try {
      await this.queue.enqueue(queue, message);
      return true;
    } catch (error) {
      this.logger.warn({
        action: 'catalog-sync.reconcile_enqueue_failed',
        integrationId: message.integrationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  // ---- report -------------------------------------------------------------------------------------------------

  private finalCounts(progress: Progress): Record<string, number> {
    const counts = { ...progress.counts };
    counts.autoFixed = progress.work.filter((w) => w.fixed).length;
    counts.needsReview = progress.work.filter((w) => w.needsReview).length;
    return counts;
  }

  /**
   * This run's findings, then the earlier run's findings: one that is found again says `still_open`, one that is gone
   * says `fixed`, both with the earlier run's id (AS-64). The earlier report itself is never touched.
   */
  private report(
    work: Work[],
    previous: ReconciliationRecord | null,
  ): ReconciliationFinding[] {
    const findings: ReconciliationFinding[] = work.map((w) => ({
      kind: w.kind,
      externalId: w.externalId,
      ...(w.detail ? { detail: w.detail } : {}),
    }));
    if (!previous) return findings;
    const current = new Map(findings.map((f) => [keyOf(f), f]));
    for (const old of previous.findings) {
      if (old.outcome === 'fixed') continue; // already closed in an earlier report
      const again = current.get(keyOf(old));
      if (again) {
        again.previousRunId = previous.id;
        again.outcome = 'still_open';
      } else {
        findings.push({
          kind: old.kind,
          externalId: old.externalId,
          previousRunId: previous.id,
          outcome: 'fixed',
        });
      }
    }
    return findings;
  }

  private async recordSkipped(
    integration: IntegrationRecord,
    outcome: SyncRunOutcome,
  ): Promise<SyncRunOutcome> {
    const at = this.clock.now();
    const id = await this.runs.start(integration.id, 'reconcile', at);
    await this.runs.finish(id, { outcome, counters: {}, detail: null }, at);
    syncRunsCounter.add(1, {
      provider: integration.provider,
      kind: 'reconcile',
      outcome,
    });
    return outcome;
  }

  // ---- routes -------------------------------------------------------------------------------------------------

  async list(
    shopId: string,
    integrationId: string,
    query: { limit: number; cursor?: string },
  ): Promise<ReconciliationPage> {
    await this.require(shopId, integrationId);
    const page = await this.reports.listPage(integrationId, query);
    return { items: page.items.map(summary), nextCursor: page.nextCursor };
  }

  async get(
    shopId: string,
    integrationId: string,
    runId: string,
  ): Promise<ReconciliationReport> {
    // An integration of another shop and an unknown run answer with the same `report_not_found` (FR-070).
    const integration = await this.integrations.findInShop(
      shopId,
      integrationId,
    );
    const record = integration
      ? await this.reports.findInIntegration(integrationId, runId)
      : null;
    if (!record) throw syncProblem('report_not_found');
    return {
      ...summary(record),
      findings: record.findings.map((f) => ({
        kind: f.kind as ReconciliationReport['findings'][number]['kind'],
        externalId: f.externalId,
        ...(f.detail ? { detail: f.detail } : {}),
        ...(f.previousRunId ? { previousRunId: f.previousRunId } : {}),
        ...(f.outcome ? { outcome: f.outcome } : {}),
      })),
      truncated: record.truncated,
      previousRunId: record.previousRunId,
    };
  }

  /**
   * On-demand run: `202` and one `reconcile` message. Only an `ACTIVE` integration can be reconciled (`409` otherwise,
   * which does not use up the hour); one per hour per integration (`429` with `Retry-After`).
   */
  async requestRun(
    shopId: string,
    integrationId: string,
  ): Promise<{ enqueued: boolean }> {
    const integration = await this.require(shopId, integrationId);
    if (integration.status !== 'ACTIVE')
      throw syncProblem('invalid_integration_transition');
    const decision = await this.limiter.check(
      'catalog-sync.reconcile-now.integration',
      integrationId,
    );
    if (!decision.allowed) {
      if (decision.reason === 'store-unavailable')
        throw new Domain_RateLimiterUnavailableError();
      throw new Domain_RateLimitedError(
        Math.max(1, Math.ceil((decision.retryAfterMs ?? 1000) / 1000)),
      );
    }
    await this.queue.enqueue(INTEGRATION_BACKFILL_QUEUE, {
      integrationId,
      kind: 'reconcile',
    });
    return { enqueued: true };
  }

  private async require(
    shopId: string,
    integrationId: string,
  ): Promise<IntegrationRecord> {
    const found = await this.integrations.findInShop(shopId, integrationId);
    if (!found) throw syncProblem('integration_not_found');
    return found;
  }
}

/** The direct read of a product answers for a variant when it lists that variant (usable or not). */
function presentIn(raw: RawItem, externalId: string): boolean {
  return raw.results.some(
    (r) => (r.ok ? r.item.externalId : r.externalId) === externalId,
  );
}

function summary(r: ReconciliationRecord): ReconciliationPage['items'][number] {
  return {
    id: r.id,
    integrationId: r.integrationId,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    outcome: r.outcome,
    counts: r.counts,
  };
}
