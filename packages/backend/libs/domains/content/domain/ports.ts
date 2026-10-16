import type { Block, Seo } from './blocks';
import type { StoryStatus, TransitionAction } from './story-status';

/**
 * Ports of the `content` domain (D-6): the application services depend on these; the Sequelize, Redis, CDN and HTTP
 * adapters live in `infra/`. Times are always passed in (platform clock). Methods that say "lock" must run inside a
 * `TransactionRunner.run` scope. Every method that touches story data takes the shop (III.4).
 */

export interface ScheduleFailure {
  at: string;
  code: string;
}

export interface StoryRecord {
  id: string;
  shopId: string;
  slug: string;
  defaultLocale: string;
  status: StoryStatus;
  publishedVersion: number | null;
  publishedAt: Date | null;
  scheduledAt: Date | null;
  scheduledBy: string | null;
  scheduleFailure: ScheduleFailure | null;
  sitemapPosition: number | null;
  createdAt: Date;
}

export interface DraftRecord {
  storyId: string;
  shopId: string;
  locale: string;
  title: string;
  blocks: Block[];
  seo: Seo;
  revision: number;
  updatedAt: Date;
}

export interface VersionRow {
  storyId: string;
  shopId: string;
  version: number;
  locale: string;
  title: string;
  blocks: Block[];
  seo: Seo;
  publishedAt: Date;
  publishedBy: string | null;
}

export interface VersionSummary {
  version: number;
  locales: string[];
  publishedAt: Date;
  publishedBy: string | null;
}

export type ShopStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';

export interface ShopCopy {
  shopId: string;
  /** Null until `tenancy.shop_created` (or `shop_updated`) names it: a status event may arrive first. */
  slug: string | null;
  status: ShopStatus;
  shopVersion: number;
}

/** What one tenancy event says about a shop: `slug` from created/updated, `status` from status changes. */
export interface ShopCopyInput {
  shopId: string;
  slug: string | null;
  status: ShopStatus | null;
  shopVersion: number;
}

export interface Keyset {
  createdAt: Date;
  id: string;
}

export interface StoryRepository {
  /**
   * Inserts a draft story. Creates of one shop are serialised (an advisory lock inside the caller's transaction), so
   * the limit holds under concurrency; the unique `(shopId, slug)` decides a duplicate slug.
   */
  insert(input: {
    id: string;
    shopId: string;
    slug: string;
    defaultLocale: string;
    now: Date;
    limit: number;
  }): Promise<'created' | 'slug_taken' | 'limit_reached'>;
  find(shopId: string, storyId: string): Promise<StoryRecord | null>;
  /** `SELECT … FOR UPDATE` of one story of the shop. */
  lock(shopId: string, storyId: string): Promise<StoryRecord | null>;
  list(
    shopId: string,
    options: { status?: StoryStatus; limit: number; after?: Keyset },
  ): Promise<StoryRecord[]>;
  /**
   * Conditional update to `PUBLISHED`: sets pointer and time, clears schedule and failure, allocates the sitemap
   * position at the first publish. Affects exactly one row or returns `false`.
   */
  markPublished(input: {
    shopId: string;
    storyId: string;
    from: StoryStatus;
    fromVersion: number | null;
    version: number;
    now: Date;
  }): Promise<boolean>;
  markArchived(input: {
    shopId: string;
    storyId: string;
    now: Date;
  }): Promise<boolean>;
  setSchedule(input: {
    shopId: string;
    storyId: string;
    scheduledAt: Date;
    scheduledBy: string;
  }): Promise<boolean>;
  clearSchedule(shopId: string, storyId: string): Promise<boolean>;
  /** Clears the schedule and records the failure of a fire (S27 AS-47). */
  recordScheduleFailure(input: {
    shopId: string;
    storyId: string;
    at: Date;
    code: string;
  }): Promise<boolean>;
  /**
   * Due schedules (`scheduledAt <= now`) of every shop, oldest first: the candidates of the sweep. Each is locked
   * and re-checked before it is published.
   */
  claimDue(
    now: Date,
    limit: number,
  ): Promise<{ id: string; shopId: string; scheduledAt: Date }[]>;
  /** The shop of a story: the one lookup by story id alone, for a scheduled job whose payload names no shop. */
  shopIdOf(storyId: string): Promise<string | null>;
  /** Slugs of a shop's published stories, keyset by id: the origin entries to clear when the shop's visibility changes. */
  publishedSlugs(
    shopId: string,
    limit: number,
    afterId?: string,
  ): Promise<{ id: string; slug: string }[]>;
}

/** The published version of a story for the public read, joined with the shop copy's visibility. */
export interface PublishedStoryReader {
  load(shopSlug: string, slug: string): Promise<PublishedSnapshot | null>;
}

export interface DraftRepository {
  list(shopId: string, storyId: string): Promise<DraftRecord[]>;
  find(
    shopId: string,
    storyId: string,
    locale: string,
  ): Promise<DraftRecord | null>;
  count(shopId: string, storyId: string): Promise<number>;
  /** Revision 0 → 1; `false` when the locale already exists (unique key). */
  insert(input: {
    shopId: string;
    storyId: string;
    locale: string;
    title: string;
    blocks: Block[];
    seo: Seo;
    now: Date;
  }): Promise<DraftRecord | null>;
  /** `WHERE revision = expected`; `null` when it no longer is. */
  update(input: {
    shopId: string;
    storyId: string;
    locale: string;
    expectedRevision: number;
    title: string;
    blocks: Block[];
    seo: Seo;
    now: Date;
  }): Promise<DraftRecord | null>;
  delete(input: {
    shopId: string;
    storyId: string;
    locale: string;
    expectedRevision: number;
  }): Promise<boolean>;
  /** Restore: the drafts become exactly `rows`, revisions advanced (S27 AS-85). */
  replaceAll(input: {
    shopId: string;
    storyId: string;
    rows: { locale: string; title: string; blocks: Block[]; seo: Seo }[];
    now: Date;
  }): Promise<void>;
}

export interface VersionRepository {
  /** Highest version of the story, 0 when none. */
  latest(shopId: string, storyId: string): Promise<number>;
  /** Freezes the drafts as `version`; returns the locales written. Rows are immutable afterwards. */
  insertFromDrafts(input: {
    shopId: string;
    storyId: string;
    version: number;
    now: Date;
    publishedBy: string | null;
  }): Promise<string[]>;
  rows(shopId: string, storyId: string, version: number): Promise<VersionRow[]>;
  list(
    shopId: string,
    storyId: string,
    options: { limit: number; before?: number },
  ): Promise<VersionSummary[]>;
}

export interface TransitionRepository {
  record(input: {
    shopId: string;
    storyId: string;
    from: StoryStatus | null;
    to: StoryStatus;
    action: TransitionAction;
    actor: string | null;
    now: Date;
  }): Promise<void>;
}

export interface ShopCopyRepository {
  /**
   * Merges one event into the copy: the status and version move only forward (`shopVersion` greater than the stored
   * one), the slug is set once (it is immutable while the shop exists). `false` when nothing changed (older, duplicate).
   */
  upsertGuarded(input: ShopCopyInput): Promise<boolean>;
  find(shopId: string): Promise<ShopCopy | null>;
  findBySlug(slug: string): Promise<ShopCopy | null>;
  /** Deletes up to `limit` stories of the shop with their drafts, versions and history; the slugs deleted. */
  purgeBatch(shopId: string, limit: number): Promise<string[]>;
  deleteCopy(shopId: string): Promise<void>;
}

export interface SitemapRow {
  position: number;
  shopSlug: string;
  slug: string;
  defaultLocale: string;
  locales: string[];
  publishedAt: Date;
}

export interface SitemapReader {
  highestPosition(): Promise<number | null>;
  /** Public stories with `position` in `[from, to]` after `afterPosition`, ascending, at most `limit` rows. */
  readBatch(input: {
    from: number;
    to: number;
    afterPosition: number;
    limit: number;
  }): Promise<SitemapRow[]>;
}

/** What the origin read model holds for a story: every locale of the published version. */
export interface PublishedSnapshot {
  storyId: string;
  shopId: string;
  shopSlug: string;
  slug: string;
  version: number;
  defaultLocale: string;
  publishedAt: string;
  locales: Record<string, { title: string; blocks: Block[]; seo: Seo }>;
}

export interface ReadModel {
  /** Single flight: at most one concurrent `load` per story; a cache failure falls back to `load`. */
  getOrLoad(
    shopSlug: string,
    slug: string,
    load: () => Promise<PublishedSnapshot | null>,
  ): Promise<PublishedSnapshot | null>;
  del(shopSlug: string, slug: string): Promise<void>;
}

export class CdnPermanentError extends Error {}
export class CdnTransientError extends Error {}

export interface CdnPurger {
  /** At most 30 tags. Throws `CdnPermanentError` (4xx other than 429) or `CdnTransientError`. */
  purgeTags(tags: string[]): Promise<void>;
}

export interface RevalidationClient {
  revalidate(tags: string[], eventId: string): Promise<void>;
}

export interface ProductReferenceChecker {
  /** The ids that are not products of the shop. Throws on S05 failure or timeout. */
  missing(shopId: string, productIds: string[]): Promise<string[]>;
}

export interface ShopLookup {
  get(shopId: string): Promise<ShopCopy | null>;
}

export interface PreviewClaims {
  storyId: string;
  shopId: string;
  locale: string;
}

export interface PreviewSigner {
  sign(claims: PreviewClaims): { token: string; expiresAt: Date };
  /** `null` for anything that is not a valid, unexpired token for this audience. */
  verify(token: string): PreviewClaims | null;
}

export const STORY_REPOSITORY = Symbol('STORY_REPOSITORY');
export const DRAFT_REPOSITORY = Symbol('DRAFT_REPOSITORY');
export const VERSION_REPOSITORY = Symbol('VERSION_REPOSITORY');
export const TRANSITION_REPOSITORY = Symbol('TRANSITION_REPOSITORY');
export const SHOP_COPY_REPOSITORY = Symbol('SHOP_COPY_REPOSITORY');
export const SITEMAP_READER = Symbol('SITEMAP_READER');
export const READ_MODEL = Symbol('READ_MODEL');
export const PUBLISHED_STORY_READER = Symbol('PUBLISHED_STORY_READER');
export const CDN_PURGER = Symbol('CDN_PURGER');
export const REVALIDATION_CLIENT = Symbol('REVALIDATION_CLIENT');
export const PRODUCT_REFERENCE_CHECKER = Symbol('PRODUCT_REFERENCE_CHECKER');
export const SHOP_LOOKUP = Symbol('SHOP_LOOKUP');
export const PREVIEW_SIGNER = Symbol('PREVIEW_SIGNER');
