import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ProductSnapshot } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { InvalidEventPayloadError } from '@app/infrastructure/events/event-errors';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { coalesceLatest } from '@app/infrastructure/projections/coalesce';
import type { SinkCounts } from '@app/infrastructure/projections/projector';
import {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from '@app/domains/catalog';
import {
  deleteMutation,
  embeddingHashOf,
  embeddingTextOf,
  productMutation,
  overlaySignals,
  restampMutation,
  type IndexedDocument,
  type EmbeddingResult,
  type Mutation,
  type ProductFacts,
  type ShopStamp,
} from '../../domain/index-document';
import {
  EMBEDDING_PROVIDER,
  PRODUCT_INDEX,
  SHOP_SEARCH_REPOSITORY,
  SHOP_STATE_REPOSITORY,
  type EmbeddingProvider,
  type ProductIndexPort,
  type ShopProductRow,
  type ShopSearchRepository,
  type ShopStateRecord,
  type ShopStateRepository,
} from '../../domain/ports';
import type { ProductEventKind } from '../../domain/projection-guard';
import {
  searchIgnoredCounter,
  searchStaleIgnoredCounter,
} from '../../infra/search-metrics';
import { SearchSettings } from '../../infra/search-settings';
import { guarded, recordLag, stampOf, UUID } from './projection-support';

const EMBEDDING_INDEXING_BUDGET_MS = 5_000;

/** How a replayed batch was accounted for: every event read is exactly one of the other four. */
export interface ReplayLedger {
  read: number;
  applied: number;
  duplicate: number;
  stale: number;
  ignored: number;
}

const SNAPSHOTS = [
  [ProductCreated, 'created'],
  [ProductUpdated, 'updated'],
  [ProductArchived, 'archived'],
  [ProductRestored, 'restored'],
] as const;

/** The catalog's contract is wide (any integer price, any string currency); search refuses what it cannot index. */
const ingestSchema = z.object({
  priceMinor: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
  quantity: z.number().int().min(0),
  rating: z.number().min(0).max(5),
  title: z.string().min(1).max(500),
});

type Parsed =
  | {
      kind: Exclude<ProductEventKind, 'deleted'>;
      envelope: EventEnvelope;
      snapshot: ProductSnapshot;
    }
  | {
      kind: 'deleted';
      envelope: EventEnvelope;
      snapshot: { productId: string; shopId: string; productVersion: number };
    };

/**
 * `catalog.product_*` into the public index and the shop search table (S32 US4). Per batch: parse and refuse bad
 * messages (dead letter, no effect), keep the highest version per product, skip sandbox products (public index only)
 * and products of deleted shops, then write the index (pure guards decide, compare-and-set writes apply) and the
 * shop table. The two stores are written one after the other; each step is idempotent and version-guarded, so a
 * failure of either retries the whole event.
 */
@Injectable()
export class ProductProjectionService {
  constructor(
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
    @Inject(SHOP_STATE_REPOSITORY) private readonly shops: ShopStateRepository,
    @Inject(SHOP_SEARCH_REPOSITORY)
    private readonly shopSearch: ShopSearchRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    private readonly settings: SearchSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const parsed = this.parse(events);
    const latest = this.latestPerProduct(parsed);
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    if (latest.length === 0) return counts;

    return guarded(async () => {
      const states = await this.shops.read([
        ...new Set(latest.map((p) => p.snapshot.shopId)),
      ]);
      const live = latest.filter((p) => {
        if (states.get(p.snapshot.shopId)?.status !== 'DELETED') return true;
        searchIgnoredCounter.add(1, { reason: 'shop_deleted' });
        return false;
      });

      const pub = live.filter(
        (p) => p.kind === 'deleted' || !(p.snapshot as ProductSnapshot).isSandbox,
      );
      for (const p of live)
        if (p.kind !== 'deleted' && (p.snapshot as ProductSnapshot).isSandbox)
          searchIgnoredCounter.add(1, { reason: 'sandbox' });

      const outcomes = await this.writeIndex(pub, states);
      for (const [, outcome] of outcomes) {
        if (outcome === 'stale') {
          counts.stale++;
          searchStaleIgnoredCounter.add(1, { source: 'product' });
        } else if (outcome === 'duplicate') counts.duplicate++;
        else counts.applied++;
      }

      await this.writeShopTable(live);
      const now = this.clock.now();
      for (const p of live) recordLag('product', p.envelope.occurredAt, now);
      return counts;
    });
  }

  /**
   * Replays history into the index a reindex run is building (S32 FR-032): the same parsing, version guards and shop
   * table writes as live projection, but the documents go only to `target`, signals the history does not carry are
   * taken from the live index, and a vector the live index already holds for the same text is reused when the
   * embedding model has not changed. Returns how every event was accounted for (the verification gate adds them up).
   */
  async replay(
    events: EventEnvelope[],
    target: { index: string; reuseVectors: boolean },
  ): Promise<ReplayLedger> {
    const ledger: ReplayLedger = {
      read: events.length,
      applied: 0,
      duplicate: 0,
      stale: 0,
      ignored: 0,
    };
    const parsed = this.parse(events);
    ledger.ignored += events.length - parsed.length;
    const latest = this.latestPerProduct(parsed);
    ledger.stale += parsed.length - latest.length;
    if (latest.length === 0) return ledger;

    // engine errors are not translated here: the run executor decides between a failed run and a retry
    return (async () => {
      const states = await this.shops.read([
        ...new Set(latest.map((p) => p.snapshot.shopId)),
      ]);
      const open = latest.filter(
        (p) => states.get(p.snapshot.shopId)?.status !== 'DELETED',
      );
      ledger.ignored += latest.length - open.length;
      const pub = open.filter(
        (p) => p.kind === 'deleted' || !(p.snapshot as ProductSnapshot).isSandbox,
      );
      ledger.ignored += open.length - pub.length;

      const outcomes = await this.writeIndex(pub, states, target);
      for (const outcome of outcomes.values()) {
        if (outcome === 'stale') ledger.stale++;
        else if (outcome === 'duplicate') ledger.duplicate++;
        else ledger.applied++;
      }
      await this.writeShopTable(open);
      return ledger;
    })();
  }

  private parse(events: EventEnvelope[]): Parsed[] {
    const out: Parsed[] = [];
    for (const envelope of events) {
      if (!UUID.test(envelope.aggregateId))
        throw new PermanentError(
          `aggregate id of ${envelope.type} is not a UUID`,
        );
      const parsed = this.parseOne(envelope);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  private parseOne(envelope: EventEnvelope): Parsed | null {
    try {
      for (const [definition, kind] of SNAPSHOTS) {
        if (envelope.type !== definition.type) continue;
        const event = definition.match(envelope);
        if (!event)
          throw new PermanentError(
            `unsupported contract version ${envelope.version} of ${envelope.type}`,
          );
        const snapshot = event.payload as ProductSnapshot;
        const refused = ingestSchema.safeParse(snapshot);
        if (!refused.success || snapshot.productId !== envelope.aggregateId)
          throw new PermanentError(
            `invalid ${envelope.type}: ${
              refused.success
                ? 'productId differs from the aggregate id'
                : refused.error.issues.map((i) => i.path.join('.')).join(', ')
            }`,
          );
        return { kind, envelope, snapshot };
      }
      if (envelope.type === ProductDeleted.type) {
        const event = ProductDeleted.match(envelope);
        if (!event)
          throw new PermanentError(
            `unsupported contract version ${envelope.version} of ${envelope.type}`,
          );
        if (event.payload.productId !== envelope.aggregateId)
          throw new PermanentError(
            'productId differs from the aggregate id',
          );
        return { kind: 'deleted', envelope, snapshot: event.payload };
      }
    } catch (error) {
      if (error instanceof InvalidEventPayloadError)
        throw new PermanentError(error.message, { cause: error });
      throw error;
    }
    searchIgnoredCounter.add(1, { reason: 'unknown_type' });
    return null;
  }

  /** One event per product: the highest `productVersion`; ties keep the later one in the batch. */
  private latestPerProduct(parsed: Parsed[]): Parsed[] {
    const byEnvelope = new Map(parsed.map((p) => [p.envelope, p]));
    return coalesceLatest(parsed.map((p) => p.envelope)).map(
      (e) => byEnvelope.get(e)!,
    );
  }

  private async writeIndex(
    products: Parsed[],
    states: Map<string, ShopStateRecord>,
    replay?: { index: string; reuseVectors: boolean },
  ) {
    const weights = this.settings.boostWeights;
    if (products.length === 0) return new Map();
    const snapshots = products.filter(
      (p): p is Extract<Parsed, { snapshot: ProductSnapshot }> =>
        p.kind !== 'deleted',
    );
    const ids = snapshots.map((p) => p.snapshot.productId);
    const stored = replay
      ? await this.index.readFrom(replay.index, ids)
      : await this.index.read(ids);
    // a replay also looks at the live index: for the signals it must keep and for vectors it may reuse
    const liveDocs = replay ? await this.index.read(ids) : new Map<string, IndexedDocument>();

    // vectors only where the text a vector is made from changed (or never had one)
    const vectors = new Map<string, EmbeddingResult>();
    await Promise.all(
      snapshots.map(async (p) => {
        const text = embeddingTextOf(p.snapshot);
        const hash = embeddingHashOf(text);
        const current = stored.get(p.snapshot.productId);
        if (current && !current.deleted && current.embeddingTextHash === hash)
          return;
        const reusable = liveDocs.get(p.snapshot.productId);
        if (
          replay?.reuseVectors &&
          reusable?.embedding &&
          reusable.embeddingTextHash === hash
        ) {
          vectors.set(p.snapshot.productId, { vector: reusable.embedding, hash });
          return;
        }
        const vector = await this.embeddings
          .embed(text, AbortSignal.timeout(EMBEDDING_INDEXING_BUDGET_MS))
          .catch(() => null);
        vectors.set(p.snapshot.productId, { vector, hash });
      }),
    );

    const stampUsed = new Map<string, ShopStamp | null>();
    const stampFor = (shopId: string): ShopStamp | null => {
      const record = states.get(shopId);
      return record ? stampOf(record) : null;
    };

    const items: { id: string; mutation: Mutation }[] = products.map((p) => {
      if (p.kind === 'deleted')
        return {
          id: p.snapshot.productId,
          mutation: deleteMutation({
            productId: p.snapshot.productId,
            shopId: p.snapshot.shopId,
            productVersion: p.snapshot.productVersion,
            occurredAt: p.envelope.occurredAt,
            weights,
          }),
        };
      const s = p.snapshot;
      stampUsed.set(s.productId, stampFor(s.shopId));
      const facts: ProductFacts = {
        productId: s.productId,
        shopId: s.shopId,
        title: s.title,
        description: s.description,
        brand: s.brand,
        category: s.category,
        priceMinor: s.priceMinor,
        currency: s.currency,
        rating: s.rating,
        tags: s.tags,
        quantity: s.quantity,
        inStock: s.inStock && s.quantity > 0,
        status: s.status,
        createdAt: s.createdAt,
        productVersion: s.productVersion,
      };
      const base = productMutation({
        facts,
        kind: p.kind,
        embedding: vectors.get(s.productId) ?? null,
        shop: stampUsed.get(s.productId) ?? null,
        weights,
      });
      const live = liveDocs.get(s.productId);
      return {
        id: s.productId,
        mutation: replay
          ? (current) => {
              const result = base(current);
              return result.next
                ? { ...result, next: overlaySignals(result.next, live, weights) }
                : result;
            }
          : base,
      };
    });

    if (replay) return this.index.mutateOn(replay.index, items);
    const outcomes = await this.index.mutate(items);

    // A shop event may have been applied between our read of its state and our write; the shop-state projector only
    // stamps documents it can see, so re-read the state and restamp where it moved on (closes the creation race).
    const after = await this.shops.read([
      ...new Set(snapshots.map((p) => p.snapshot.shopId)),
    ]);
    const restamp: { id: string; mutation: Mutation }[] = [];
    for (const p of snapshots) {
      if (outcomes.get(p.snapshot.productId) === 'stale') continue;
      const record = after.get(p.snapshot.shopId);
      const used = stampUsed.get(p.snapshot.productId) ?? null;
      if (!record) continue;
      const current = stampOf(record);
      if (used && used.version === current.version && used.at === current.at)
        continue;
      restamp.push({
        id: p.snapshot.productId,
        mutation: restampMutation(current, weights),
      });
    }
    if (restamp.length > 0) await this.index.mutate(restamp);
    return outcomes;
  }

  private async writeShopTable(products: Parsed[]): Promise<void> {
    const upserts: (ShopProductRow & {
      kind: Exclude<ProductEventKind, 'deleted'>;
    })[] = [];
    const deletes: {
      productId: string;
      shopId: string;
      productVersion: number;
      at: Date;
    }[] = [];
    for (const p of products) {
      if (p.kind === 'deleted') {
        deletes.push({
          productId: p.snapshot.productId,
          shopId: p.snapshot.shopId,
          productVersion: p.snapshot.productVersion,
          at: new Date(p.envelope.occurredAt),
        });
        continue;
      }
      const s = p.snapshot;
      upserts.push({
        kind: p.kind,
        productId: s.productId,
        shopId: s.shopId,
        title: s.title,
        brand: s.brand || null,
        status: s.status,
        priceMinor: s.priceMinor,
        currency: s.currency,
        quantity: s.quantity,
        isSandbox: s.isSandbox,
        productVersion: s.productVersion,
      });
    }
    await this.shopSearch.upsert(upserts);
    await this.shopSearch.markDeleted(deletes);
  }
}
