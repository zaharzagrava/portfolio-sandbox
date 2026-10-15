import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TransactionRunner } from '@app/infrastructure/context';
import type { NormalisedItem } from '../domain/normalise';
import {
  CATALOG_GATEWAY,
  LINK_REPOSITORY,
  QUARANTINE_REPOSITORY,
  SYNC_CLOCK,
  type CatalogGateway,
  type CatalogUpsertItem,
  type Clock,
  type IntegrationRecord,
  type LinkRecord,
  type LinkRepository,
  type QuarantineRepository,
  type RawItem,
  type StockDeltaOp,
  type SyncCounters,
} from '../domain/ports';
import { PRODUCT_ENTITY } from './integration-view.service';
import { syncItemsCounter } from './sync-metrics';
import type { StockCandidate } from '../domain/ports/records';

/** `upsertFromExternal` takes at most this many items per call (S05). */
export const CATALOG_BATCH = 500;
/** Raw payload kept per link (FR-021); larger items are quarantined `payload_too_large`. */
export const MAX_RAW_BYTES = 256 * 1024;

export type ApplyOutcome =
  | {
      kind: 'applied';
      counters: SyncCounters;
      maxUpdatedAt: Date | null;
      /** Variants that had a live link and whose item was not stale or refused: their stock goes through the merge. */
      stock: StockCandidate[];
      /** The run's quarantine limit was reached while reading this page; the rest of the page was not looked at (AS-53). */
      halted: boolean;
    }
  /** `ShopNotActiveError` from the catalog: the run ends `skipped_shop_not_active`. */
  | { kind: 'shop_not_active'; counters: SyncCounters };

export const emptyCounters = (): SyncCounters => ({
  fetched: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  quarantined: 0,
  stale: 0,
});

interface Entry {
  item: NormalisedItem;
  raw: unknown;
  link: LinkRecord | undefined;
}

/**
 * Turns one page of normalised provider items into catalog products and links (FR-021 - FR-024, AS-12, AS-13).
 * The catalog is called outside any transaction, with the deterministic `externalSku`, so a crash between the catalog
 * call and the link write is repaired by the retry (the product is found `unchanged`/`updated`, the link is written).
 * The link write and the counters are the capability's own short transaction afterwards.
 */
@Injectable()
export class LinkApplyService {
  private readonly logger = new Logger(LinkApplyService.name);

  constructor(
    private readonly transactions: TransactionRunner,
    @Inject(CATALOG_GATEWAY) private readonly catalog: CatalogGateway,
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(QUARANTINE_REPOSITORY)
    private readonly quarantine: QuarantineRepository,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {}

  async applyItems(
    integration: IntegrationRecord,
    items: RawItem[],
    options: { quarantineLimit?: number } = {},
  ): Promise<ApplyOutcome> {
    const counters = emptyCounters();
    const entries: Entry[] = [];
    let maxUpdatedAt: Date | null = null;
    let halted = false;
    const limit = options.quarantineLimit ?? Number.POSITIVE_INFINITY;

    reading: for (const raw of items) {
      for (const result of raw.results) {
        if (result.ok) {
          const bytes = Buffer.byteLength(JSON.stringify(raw.raw));
          if (bytes > MAX_RAW_BYTES) {
            counters.fetched++;
            await this.quarantineItem(
              integration,
              result.item.externalId,
              'payload_too_large',
              raw.raw,
            );
            counters.quarantined++;
            maxUpdatedAt = later(maxUpdatedAt, rawUpdatedAt(raw.raw));
            if (counters.quarantined >= limit) {
              halted = true;
              break reading;
            }
            continue;
          }
          entries.push({ item: result.item, raw: raw.raw, link: undefined });
          counters.fetched++;
          if (!maxUpdatedAt || result.item.updatedAt > maxUpdatedAt)
            maxUpdatedAt = result.item.updatedAt;
        } else if (result.code !== 'unlisted') {
          counters.fetched++;
          await this.quarantineItem(
            integration,
            result.externalId,
            result.code,
            raw.raw,
          );
          counters.quarantined++;
          // A bad item must not hold the watermark back: the pass moves past it (AS-47).
          maxUpdatedAt = later(maxUpdatedAt, rawUpdatedAt(raw.raw));
          if (counters.quarantined >= limit) {
            halted = true;
            break reading;
          }
        }
      }
    }

    const existing = await this.links.findMany(
      integration.id,
      entries.map((e) => e.item.externalId),
    );
    const todo: Entry[] = [];
    const refused = new Set<string>();
    const mergeable = new Map<string, Entry>();
    for (const entry of entries) {
      entry.link = existing.get(entry.item.externalId);
      const link = entry.link;
      if (!link) todo.push(entry);
      else if (link.state === 'IGNORED') counters.unchanged++;
      else if (
        link.remoteUpdatedAt &&
        entry.item.updatedAt < link.remoteUpdatedAt
      )
        counters.stale++;
      else {
        mergeable.set(entry.item.externalId, entry);
        if (
          link.state === 'ACTIVE' &&
          link.contentDigest === entry.item.contentDigest
        )
          counters.unchanged++;
        else todo.push(entry);
      }
    }

    for (let i = 0; i < todo.length; i += CATALOG_BATCH) {
      const chunk = todo.slice(i, i + CATALOG_BATCH);
      const outcome = await this.catalog.upsertItems(
        integration.shopId,
        chunk.map((e) => this.toCatalogItem(e)),
        integration.provider,
      );
      if (outcome.kind === 'shop_not_active') {
        this.countItems(integration, counters);
        return { kind: 'shop_not_active', counters };
      }

      const bySku = new Map(outcome.results.map((r) => [r.externalSku, r]));
      const writes: Array<{
        entry: Entry;
        productId: string;
        productVersion: number | null;
      }> = [];
      for (const entry of chunk) {
        const result = bySku.get(entry.item.externalSku);
        if (!result || result.outcome === 'rejected' || !result.productId) {
          const why = (result?.errors ?? [])
            .map((e) => `${e.field}:${e.code}`)
            .join(',');
          mergeable.delete(entry.item.externalId);
          refused.add(entry.item.externalId);
          await this.quarantineItem(
            integration,
            entry.item.externalId,
            'catalog_rejected',
            entry.raw,
            why,
          );
          counters.quarantined++;
          continue;
        }
        counters[result.outcome]++;
        writes.push({
          entry,
          productId: result.productId,
          productVersion: result.productVersion ?? null,
        });
      }
      if (writes.length > 0)
        await this.transactions.run(async () => {
          // Per-(integration, externalId) apply lock: two appliers of one variant (a page and a webhook fetch) write its
          // link one after the other, and the second sees the first one's link instead of treating the variant as new.
          await this.links.lockApply(
            integration.id,
            writes.map((w) => w.entry.item.externalId),
          );
          for (const { entry, productId, productVersion } of writes) {
            const current =
              entry.link ??
              (await this.links.getForUpdate(
                integration.id,
                entry.item.externalId,
                PRODUCT_ENTITY,
              ));
            await this.links.upsertApplied({
              integrationId: integration.id,
              shopId: integration.shopId,
              entity: PRODUCT_ENTITY,
              externalId: entry.item.externalId,
              localId: productId,
              contentDigest: entry.item.contentDigest,
              // The agreed stock is only set when the product is first linked; later stock changes go through the merge.
              syncedStock: current ? null : entry.item.stock,
              remoteUpdatedAt: entry.item.updatedAt,
              lastLocalVersion: current ? null : productVersion,
              raw: entry.raw,
            });
          }
        });
    }
    // An item that is valid again closes its open quarantine row (AS-49).
    const accepted = entries
      .map((e) => e.item.externalId)
      .filter((id) => !refused.has(id));
    if (accepted.length > 0)
      await this.quarantine.resolveMany(
        integration.id,
        PRODUCT_ENTITY,
        accepted,
        this.clock.now(),
      );

    const stock = [...mergeable.values()].map((e) => ({
      externalId: e.item.externalId,
      stock: e.item.stock,
      updatedAt: e.item.updatedAt,
    }));
    this.countItems(integration, counters);
    return { kind: 'applied', counters, maxUpdatedAt, stock, halted };
  }

  /** FR-102 `items_total` by result; quarantined items are counted one by one where they are quarantined. */
  private countItems(
    integration: IntegrationRecord,
    counters: SyncCounters,
  ): void {
    for (const result of ['created', 'updated', 'unchanged', 'stale'] as const)
      if (counters[result] > 0)
        syncItemsCounter.add(counters[result], {
          provider: integration.provider,
          result,
        });
  }

  /**
   * The provider confirmed (a direct read answered "gone") that a product no longer exists (AS-30, AS-62): each of its
   * links becomes `DELETED_AT_PROVIDER` and the local stock goes to zero through the catalog's stock command
   * (`sync:<integration>:<digest>`, reason `sync-deleted`). The local product is kept. The stock command comes first and is
   * idempotent, so a crash between the two steps is repaired by the redelivered message. Returns the links changed.
   */
  async markDeleted(
    integration: IntegrationRecord,
    providerExternalId: string,
  ): Promise<number> {
    const live = (
      await this.links.findByProduct(
        integration.id,
        providerExternalId,
        PRODUCT_ENTITY,
      )
    ).filter((l) => l.state === 'ACTIVE' || l.state === 'UNLISTED');
    if (live.length === 0) return 0;

    const products = await this.catalog.getProducts(
      integration.shopId,
      live.map((l) => l.localId),
    );
    const ops: StockDeltaOp[] = [];
    for (const link of live) {
      const quantity = products.get(link.localId)?.quantity ?? 0;
      if (quantity <= 0) continue;
      const digest = createHash('sha256')
        .update(`deleted:${link.externalId}:${link.contentDigest ?? ''}`)
        .digest('hex')
        .slice(0, 32);
      ops.push({
        operationId: `sync:${integration.id}:${digest}`,
        productId: link.localId,
        shopId: integration.shopId,
        delta: -quantity,
        reason: 'sync-deleted',
      });
    }
    if (ops.length > 0) {
      const outcome = await this.catalog.applyStockDelta(ops);
      // `operation_conflict`: the same operation id was applied before with another amount, i.e. the zeroing already happened.
      if (outcome.kind === 'rejected')
        throw new Error(
          `stock zeroing refused: ${outcome.failures.map((f) => f.code).join(',')}`,
        );
    }

    let changed = 0;
    for (const link of live)
      if (
        await this.links.markState(
          integration.id,
          link.externalId,
          'DELETED_AT_PROVIDER',
          link.state,
          PRODUCT_ENTITY,
        )
      ) {
        changed++;
        // Both sides now agree on zero: a variant relisted later merges its stock from base 0 (AS-62, AS-45).
        await this.links.recordStock(
          integration.id,
          link.externalId,
          { syncedStock: 0, lastStockWriteAt: this.clock.now() },
          PRODUCT_ENTITY,
        );
      }
    return changed;
  }

  /** `quantity` only for an item without a link: S05 sets stock absolutely on an existing product (gaps.md A4). */
  private toCatalogItem(entry: Entry): CatalogUpsertItem {
    const { item, link } = entry;
    return {
      externalSku: item.externalSku,
      title: item.title,
      description: item.description,
      brand: item.brand,
      category: item.category,
      priceMinor: item.priceMinor,
      tags: item.tags,
      ...(link ? {} : { quantity: item.stock }),
    };
  }

  private async quarantineItem(
    integration: IntegrationRecord,
    externalId: string | null,
    reasonCode: string,
    payload: unknown,
    detail?: string,
  ): Promise<void> {
    syncItemsCounter.add(1, {
      provider: integration.provider,
      result: 'quarantined',
    });
    // Identifiers and the reason only: the payload never goes to a log (AS-47, AS-78).
    this.logger.warn({
      action: 'catalog-sync.item_quarantined',
      integrationId: integration.id,
      shopId: integration.shopId,
      externalId,
      reasonCode,
    });
    const payloadDigest = createHash('sha256')
      .update(JSON.stringify(payload ?? null))
      .digest('hex');
    await this.quarantine.record(
      {
        integrationId: integration.id,
        entity: PRODUCT_ENTITY,
        externalId,
        dedupeKey: externalId ?? payloadDigest,
        payloadDigest,
        reasonCode,
        message: detail ? `${reasonCode}: ${detail}` : reasonCode,
        // An oversized payload is not stored again in the quarantine row.
        payload: reasonCode === 'payload_too_large' ? null : payload,
      },
      this.clock.now(),
    );
  }
}

const later = (a: Date | null, b: Date | null): Date | null =>
  a && b ? (b > a ? b : a) : (a ?? b);

/** Best-effort `updatedAt` of a raw item that did not normalise (Shopify `updated_at`, WooCommerce `date_modified_gmt`). */
function rawUpdatedAt(raw: unknown): Date | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const value = record.updated_at ?? record.date_modified_gmt;
  if (typeof value !== 'string') return null;
  const at = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}
