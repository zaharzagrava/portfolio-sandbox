import type { LinkRecord, LinkState } from './records';

export const LINK_REPOSITORY = Symbol('LINK_REPOSITORY');

export interface UpsertAppliedInput {
  integrationId: string;
  shopId: string;
  entity?: string;
  externalId: string;
  localId: string;
  contentDigest: string;
  syncedStock: number | null;
  remoteUpdatedAt: Date | null;
  lastLocalVersion?: number | null;
  raw: unknown;
}

export interface LinkRepository {
  /** Plain read of the links of these external ids (one query, <= 500 ids); absent ids are not in the map. */
  findMany(
    integrationId: string,
    externalIds: string[],
    entity?: string,
  ): Promise<Map<string, LinkRecord>>;
  /**
   * Every link of one provider product: `<productId>` itself (a simple WooCommerce product) and `<productId>:<variantId>`.
   * `providerProductId` may also be a full `<productId>:<variantId>` id, then it matches that one link.
   */
  findByProduct(
    integrationId: string,
    providerProductId: string,
    entity?: string,
  ): Promise<LinkRecord[]>;
  /** `SELECT ... FOR UPDATE`; requires an active transaction (apply lock per `(integration, externalId)`). */
  getForUpdate(
    integrationId: string,
    externalId: string,
    entity?: string,
  ): Promise<LinkRecord | null>;
  /**
   * Transaction-scoped advisory lock per `(integration, externalId)` (taken in sorted order, so two appliers of
   * overlapping sets cannot deadlock). It also covers an external id that has no link row yet, which `getForUpdate`
   * cannot lock. Requires an active transaction; released at its end.
   */
  lockApply(
    integrationId: string,
    externalIds: string[],
    entity?: string,
  ): Promise<void>;
  /** Insert or update; state becomes ACTIVE. */
  upsertApplied(input: UpsertAppliedInput): Promise<void>;
  /** `from` given: conditional. Returns whether a row changed. */
  markState(
    integrationId: string,
    externalId: string,
    state: LinkState,
    from?: LinkState,
    entity?: string,
  ): Promise<boolean>;
  /** After a push or an inbound stock write. */
  recordStock(
    integrationId: string,
    externalId: string,
    values: {
      syncedStock: number;
      lastStockWriteAt: Date;
      lastLocalVersion?: number | null;
    },
    entity?: string,
  ): Promise<boolean>;
  /** `shopId` in the predicate (AS-40); the links of one local product across the shop's integrations. */
  findByLocal(shopId: string, productId: string): Promise<LinkRecord[]>;
  /** Local product deleted: every link of it becomes IGNORED (terminal). Returns the count. */
  ignoreByLocal(shopId: string, productId: string): Promise<number>;
  /** Keyset by `externalId` for reconciliation (internal, not an HTTP cursor). */
  pageForReconcile(
    integrationId: string,
    afterExternalId: string | null,
    limit: number,
  ): Promise<LinkRecord[]>;
  countLinked(integrationId: string): Promise<number>;
}
