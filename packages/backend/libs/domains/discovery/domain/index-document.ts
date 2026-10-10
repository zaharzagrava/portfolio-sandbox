import { createHash } from 'node:crypto';
import {
  baseMultiplier,
  businessMultiplier,
  type BoostTier,
  type BoostWeights,
} from './boost';
import {
  decideMedia,
  decidePopularity,
  decideProduct,
  decideSponsorship,
  type GuardOutcome,
  type ProductEventKind,
} from './projection-guard';

/**
 * One document of the public products index as the domain sees it (data-model section 2). The fields of a product
 * and the fields of each signal (shop state, image, sponsorship, popularity) are written by different sources, each
 * under its own version; a document that only holds signals has `hasProduct: false` and is never visible.
 */
export interface IndexedDocument {
  productId: string;
  shopId: string | null;
  title: string | null;
  brand: string | null;
  description: string | null;
  tags: string[];
  category: string | null;
  priceMinor: number | null;
  currency: string | null;
  rating: number;
  inStock: boolean;
  status: 'ACTIVE' | 'ARCHIVED' | null;
  createdAt: string | null;
  productVersion: number | null;
  hasProduct: boolean;
  deleted: boolean;
  deletedAt: string | null;
  embedding: number[] | null;
  embeddingPending: boolean;
  embeddingTextHash: string | null;
  shopStatus: string | null;
  shopHidden: boolean;
  shopTier: BoostTier | null;
  shopStateVersion: number | null;
  shopStateAt: string | null;
  imageUrl: string | null;
  galleryVersion: number | null;
  sponsored: boolean;
  sponsorshipVersion: number | null;
  popularityBucket: number;
  popularityAt: string | null;
  /** Business multiplier without the plan tier; the score is this times the tier factor, capped (engine side too). */
  browseBase: number;
  browseScore: number;
}

export const emptyDocument = (productId: string): IndexedDocument => ({
  productId,
  shopId: null,
  title: null,
  brand: null,
  description: null,
  tags: [],
  category: null,
  priceMinor: null,
  currency: null,
  rating: 0,
  inStock: false,
  status: null,
  createdAt: null,
  productVersion: null,
  hasProduct: false,
  deleted: false,
  deletedAt: null,
  embedding: null,
  embeddingPending: false,
  embeddingTextHash: null,
  shopStatus: null,
  shopHidden: false,
  shopTier: null,
  shopStateVersion: null,
  shopStateAt: null,
  imageUrl: null,
  galleryVersion: null,
  sponsored: false,
  sponsorshipVersion: null,
  popularityBucket: 0,
  popularityAt: null,
  browseBase: 1,
  browseScore: 1,
});

/** `browseBase` and `browseScore` recomputed from the signals a document holds (called by every source that writes). */
export function withScores(
  doc: IndexedDocument,
  weights: BoostWeights,
): IndexedDocument {
  const base = baseMultiplier(
    {
      inStock: doc.inStock,
      rating: doc.rating,
      popularityBucket: doc.popularityBucket,
      sponsored: doc.sponsored,
    },
    weights,
  );
  const score = businessMultiplier(
    {
      inStock: doc.inStock,
      rating: doc.rating,
      popularityBucket: doc.popularityBucket,
      tier: doc.shopTier,
      sponsored: doc.sponsored,
    },
    weights,
  );
  return { ...doc, browseBase: base, browseScore: score };
}

/** What the product source writes. `embedding` is undefined when the stored vector must be kept. */
export interface ProductFacts {
  productId: string;
  shopId: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: number;
  currency: string;
  rating: number;
  tags: string[];
  quantity: number;
  inStock: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  productVersion: number;
}

/** Hash of the text a vector is computed from; a changed hash means the vector is stale (not `changedFields`). */
export const embeddingTextOf = (p: {
  title: string;
  description: string;
  brand: string;
  category: string;
  tags: string[];
}): string =>
  [p.title, p.description, p.brand, p.category, ...p.tags].join('\n');

export const embeddingHashOf = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

export interface EmbeddingResult {
  /** The vector computed for `hash`; null when the provider failed (the document is flagged pending). */
  vector: number[] | null;
  hash: string;
}

export interface ShopStamp {
  status: string;
  hidden: boolean;
  tier: BoostTier | null;
  version: number | null;
  at: string;
}

export interface MutationResult {
  outcome: GuardOutcome;
  /** The document to store; null to leave the stored one untouched. */
  next: IndexedDocument | null;
}

/** A pure function of the stored document (null = absent) to the document to store. */
export type Mutation = (stored: IndexedDocument | null) => MutationResult;

const stamp = (doc: IndexedDocument, shop: ShopStamp | null) =>
  shop
    ? {
        ...doc,
        shopStatus: shop.status,
        shopHidden: shop.hidden,
        shopTier: shop.tier,
        shopStateVersion: shop.version,
        shopStateAt: shop.at,
      }
    : doc;

/** Product snapshot (created / updated / archived / restored) applied under the product guard. */
export function productMutation(input: {
  facts: ProductFacts;
  kind: Exclude<ProductEventKind, 'deleted'>;
  embedding: EmbeddingResult | null;
  /** Shop state to stamp when the document does not exist yet (or never got a stamp). */
  shop: ShopStamp | null;
  weights: BoostWeights;
}): Mutation {
  return (stored) => {
    const outcome = decideProduct(
      stored && stored.productVersion !== null
        ? { version: stored.productVersion, deleted: stored.deleted }
        : null,
      { version: input.facts.productVersion, kind: input.kind },
    );
    if (outcome === 'stale') return { outcome, next: null };
    const base = stored ?? emptyDocument(input.facts.productId);
    const f = input.facts;
    const textHash = embeddingHashOf(embeddingTextOf(f));
    let embedding = base.embedding;
    let embeddingPending = base.embeddingPending;
    let embeddingTextHash = base.embeddingTextHash;
    if (base.embeddingTextHash !== textHash || base.deleted) {
      if (input.embedding && input.embedding.hash === textHash) {
        embedding = input.embedding.vector;
        embeddingPending = input.embedding.vector === null;
        embeddingTextHash = input.embedding.vector ? textHash : null;
      } else {
        // The vector the handler computed is not for this text (or none was computed): keep it findable lexically.
        embedding = null;
        embeddingPending = true;
        embeddingTextHash = null;
      }
    }
    let next: IndexedDocument = {
      ...base,
      shopId: f.shopId,
      title: f.title,
      brand: f.brand || null,
      description: f.description,
      tags: f.tags,
      category: f.category,
      priceMinor: f.priceMinor,
      currency: f.currency,
      rating: f.rating,
      inStock: f.inStock,
      status: f.status,
      createdAt: f.createdAt,
      productVersion: f.productVersion,
      hasProduct: true,
      deleted: false,
      deletedAt: null,
      embedding,
      embeddingPending,
      embeddingTextHash,
    };
    if (base.shopStateAt === null) next = stamp(next, input.shop);
    return { outcome, next: withScores(next, input.weights) };
  };
}

/** A delete leaves a tombstone: the product fields and the vector go, the signals and the version stay. */
export function deleteMutation(input: {
  productId: string;
  shopId: string;
  productVersion: number;
  occurredAt: string;
  weights: BoostWeights;
}): Mutation {
  return (stored) => {
    const outcome = decideProduct(
      stored && stored.productVersion !== null
        ? { version: stored.productVersion, deleted: stored.deleted }
        : null,
      { version: input.productVersion, kind: 'deleted' },
    );
    if (outcome === 'stale') return { outcome, next: null };
    const base = stored ?? emptyDocument(input.productId);
    return {
      outcome,
      next: withScores(
        {
          ...emptyDocument(input.productId),
          shopStatus: base.shopStatus,
          shopHidden: base.shopHidden,
          shopTier: base.shopTier,
          shopStateVersion: base.shopStateVersion,
          shopStateAt: base.shopStateAt,
          imageUrl: base.imageUrl,
          galleryVersion: base.galleryVersion,
          sponsored: base.sponsored,
          sponsorshipVersion: base.sponsorshipVersion,
          popularityBucket: base.popularityBucket,
          popularityAt: base.popularityAt,
          shopId: input.shopId,
          productVersion: input.productVersion,
          deleted: true,
          deletedAt: input.occurredAt,
        },
        input.weights,
      ),
    };
  };
}

/** Image from `media.gallery_changed`, guarded by `galleryVersion` (own source, own version). */
export function galleryMutation(input: {
  productId: string;
  shopId: string;
  imageUrl: string | null;
  galleryVersion: number;
  weights: BoostWeights;
}): Mutation {
  return (stored) => {
    const outcome = decideMedia(stored?.galleryVersion ?? null, input.galleryVersion);
    if (outcome === 'stale') return { outcome, next: null };
    const base = stored ?? emptyDocument(input.productId);
    return {
      outcome,
      next: withScores(
        {
          ...base,
          shopId: base.shopId ?? input.shopId,
          imageUrl: input.imageUrl,
          galleryVersion: input.galleryVersion,
        },
        input.weights,
      ),
    };
  };
}

/** Sponsored flag from `marketing.product_sponsorship_changed`, guarded by `sponsorshipVersion`. */
export function sponsorshipMutation(input: {
  productId: string;
  shopId: string;
  sponsored: boolean;
  sponsorshipVersion: number;
  weights: BoostWeights;
}): Mutation {
  return (stored) => {
    const outcome = decideSponsorship(
      stored?.sponsorshipVersion ?? null,
      input.sponsorshipVersion,
    );
    if (outcome === 'stale') return { outcome, next: null };
    const base = stored ?? emptyDocument(input.productId);
    return {
      outcome,
      next: withScores(
        {
          ...base,
          shopId: base.shopId ?? input.shopId,
          sponsored: input.sponsored,
          sponsorshipVersion: input.sponsorshipVersion,
        },
        input.weights,
      ),
    };
  };
}

/** Popularity bucket from the refresh job, guarded by its computation time (epoch ms). */
export function popularityMutation(input: {
  productId: string;
  bucket: number;
  at: Date;
  weights: BoostWeights;
}): Mutation {
  return (stored) => {
    if (!stored) return { outcome: 'stale', next: null };
    const outcome = decidePopularity(
      stored.popularityAt ? Date.parse(stored.popularityAt) : null,
      input.at.getTime(),
    );
    if (outcome === 'stale' || stored.popularityBucket === input.bucket)
      return { outcome: outcome === 'stale' ? 'stale' : 'duplicate', next: null };
    return {
      outcome,
      next: withScores(
        {
          ...stored,
          popularityBucket: input.bucket,
          popularityAt: input.at.toISOString(),
        },
        input.weights,
      ),
    };
  };
}

/** Re-stamp the shop state onto a document when the stored stamp is older than the given state. */
export function restampMutation(
  shop: ShopStamp,
  weights: BoostWeights,
): Mutation {
  return (stored) => {
    if (!stored) return { outcome: 'stale', next: null };
    const newer =
      stored.shopStateAt === null ||
      (stored.shopStateVersion !== null &&
      shop.version !== null &&
      shop.version !== stored.shopStateVersion
        ? shop.version > stored.shopStateVersion
        : Date.parse(shop.at) > Date.parse(stored.shopStateAt));
    if (!newer) return { outcome: 'stale', next: null };
    return {
      outcome: 'applied',
      next: withScores(stamp(stored, shop), weights),
    };
  };
}

/** Fills a missing vector (backfill job); only when the stored text is still the text the vector was made from. */
export function embeddingFillMutation(input: {
  hash: string;
  vector: number[];
}): Mutation {
  return (stored) => {
    if (
      !stored ||
      !stored.hasProduct ||
      stored.deleted ||
      !stored.embeddingPending ||
      embeddingHashOf(
        embeddingTextOf({
          title: stored.title ?? '',
          description: stored.description ?? '',
          brand: stored.brand ?? '',
          category: stored.category ?? '',
          tags: stored.tags,
        }),
      ) !== input.hash
    )
      return { outcome: 'stale', next: null };
    return {
      outcome: 'applied',
      next: {
        ...stored,
        embedding: input.vector,
        embeddingPending: false,
        embeddingTextHash: input.hash,
      },
    };
  };
}

/** Whether a shop stamp candidate supersedes the one a document holds (own version when both have one, else time). */
export const stampIsNewer = (
  candidate: { version: number | null; at: string },
  current: { version: number | null; at: string | null },
): boolean =>
  current.at === null ||
  (current.version !== null &&
  candidate.version !== null &&
  candidate.version !== current.version
    ? candidate.version > current.version
    : Date.parse(candidate.at) > Date.parse(current.at));

/**
 * A document built from a replayed product event takes every signal the live document holds whose own version is
 * newer than the one it has (a replay carries the product, never the image, sponsorship, popularity or shop stamp).
 */
export function overlaySignals(
  doc: IndexedDocument,
  live: IndexedDocument | undefined,
  weights: BoostWeights,
): IndexedDocument {
  if (!live) return doc;
  const next = { ...doc };
  if (
    live.galleryVersion !== null &&
    (next.galleryVersion === null || live.galleryVersion > next.galleryVersion)
  ) {
    next.imageUrl = live.imageUrl;
    next.galleryVersion = live.galleryVersion;
  }
  if (
    live.sponsorshipVersion !== null &&
    (next.sponsorshipVersion === null ||
      live.sponsorshipVersion > next.sponsorshipVersion)
  ) {
    next.sponsored = live.sponsored;
    next.sponsorshipVersion = live.sponsorshipVersion;
  }
  if (
    live.popularityAt !== null &&
    (next.popularityAt === null ||
      Date.parse(live.popularityAt) > Date.parse(next.popularityAt))
  ) {
    next.popularityBucket = live.popularityBucket;
    next.popularityAt = live.popularityAt;
  }
  if (
    live.shopStateAt !== null &&
    stampIsNewer(
      { version: live.shopStateVersion, at: live.shopStateAt },
      { version: next.shopStateVersion, at: next.shopStateAt },
    )
  ) {
    next.shopStatus = live.shopStatus;
    next.shopHidden = live.shopHidden;
    next.shopTier = live.shopTier;
    next.shopStateVersion = live.shopStateVersion;
    next.shopStateAt = live.shopStateAt;
  }
  return withScores(next, weights);
}
