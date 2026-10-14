import type { WidgetThemeValues } from './theme';

/**
 * Ports of the widget capability (S44 G-39, D-6): services depend on these, never on Sequelize, Redis, `jsonwebtoken`,
 * the random source or another domain's service. Adapters live in `infra/`.
 */

export interface WidgetSiteRecord {
  id: string;
  shopId: string;
  name: string;
  publishableKey: string;
  allowedOrigins: string[];
  featuredProductIds: string[];
  theme: WidgetThemeValues;
  killSwitch: boolean;
  previousSecretExpiresAt: Date | null;
  /** A previous sealed secret is stored (it may be past its expiry: `previousSecretState` decides at use time). */
  hasPreviousSecret: boolean;
  version: number;
  shopName: string;
  shopStatus: string;
  shopVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What the public routes need to decide, as plain JSON (it is the cached record): no sealed secret ever enters the cache.
 */
export interface WidgetSiteView {
  id: string;
  shopId: string;
  publishableKey: string;
  allowedOrigins: string[];
  featuredProductIds: string[];
  theme: WidgetThemeValues;
  killSwitch: boolean;
  version: number;
  shopName: string;
  shopStatus: string;
  shopVersion: number;
}

export interface WidgetSecrets {
  current: string;
  previous: string | null;
  previousExpiresAt: Date | null;
}

export type WidgetChange =
  | 'created'
  | 'origins_changed'
  | 'products_changed'
  | 'theme_changed'
  | 'secret_rotated'
  | 'previous_secret_expired'
  | 'kill_switch_on'
  | 'kill_switch_off'
  | 'deleted';

export interface NewWidgetSite {
  id: string;
  shopId: string;
  name: string;
  publishableKey: string;
  allowedOrigins: string[];
  featuredProductIds: string[];
  identitySecretSealed: string;
  shopName: string;
  shopStatus: string;
  shopVersion: number;
}

export type CreateSiteOutcome =
  | { outcome: 'created'; site: WidgetSiteRecord }
  | { outcome: 'limit_reached' }
  | { outcome: 'key_taken' };

export interface SitePatch {
  name?: string;
  allowedOrigins?: string[];
  featuredProductIds?: string[];
  theme?: WidgetThemeValues;
}

export type UpdateSiteOutcome =
  | { outcome: 'updated'; site: WidgetSiteRecord; changes: WidgetChange[] }
  | { outcome: 'not_found' }
  | { outcome: 'conflict' };

export type RotateOutcome =
  | { outcome: 'rotated'; site: WidgetSiteRecord }
  | { outcome: 'not_found' }
  | { outcome: 'in_progress' };

export type ExpireOutcome =
  | { outcome: 'expired'; site: WidgetSiteRecord }
  | { outcome: 'not_found' }
  | { outcome: 'not_in_progress' };

export type KillOutcome =
  | { outcome: 'changed'; site: WidgetSiteRecord }
  | { outcome: 'unchanged'; site: WidgetSiteRecord }
  | { outcome: 'not_found' };

export interface HistoryItem {
  id: string;
  change: string;
  from: string | null;
  to: string | null;
  actorId: string | null;
  at: Date;
  seq: number;
}

export interface ShopCopyUpdate {
  shopVersion: number;
  name?: string;
  status?: string;
}

/** `WidgetSite` and `WidgetSiteChange` in Postgres: every lookup carries the shop; every change is one conditional statement. */
export abstract class WidgetSiteRepository {
  abstract createWithLimit(input: {
    site: NewWidgetSite;
    limit: number;
    now: Date;
    actorId: string;
  }): Promise<CreateSiteOutcome>;
  abstract findForShop(
    shopId: string,
    siteId: string,
  ): Promise<WidgetSiteRecord | null>;
  abstract findViewByKey(key: string): Promise<WidgetSiteView | null>;
  abstract findViewById(siteId: string): Promise<WidgetSiteView | null>;
  abstract secretsOf(siteId: string): Promise<WidgetSecrets | null>;
  abstract list(
    shopId: string,
    page: { limit: number; after?: { createdAt: Date; id: string } },
  ): Promise<WidgetSiteRecord[]>;
  abstract update(input: {
    shopId: string;
    siteId: string;
    expectedVersion: number;
    patch: SitePatch;
    now: Date;
    actorId: string;
  }): Promise<UpdateSiteOutcome>;
  abstract rotateSecret(input: {
    shopId: string;
    siteId: string;
    newSealed: string;
    overlapHours: number;
    now: Date;
    actorId: string;
  }): Promise<RotateOutcome>;
  abstract expirePreviousSecret(input: {
    shopId: string;
    siteId: string;
    now: Date;
    actorId: string;
  }): Promise<ExpireOutcome>;
  abstract setKillSwitch(input: {
    shopId: string;
    siteId: string;
    on: boolean;
    now: Date;
    actorId: string;
  }): Promise<KillOutcome>;
  abstract delete(input: {
    shopId: string;
    siteId: string;
    now: Date;
    actorId: string;
  }): Promise<
    { outcome: 'deleted'; publishableKey: string } | { outcome: 'not_found' }
  >;
  abstract history(
    shopId: string,
    siteId: string,
    page: { limit: number; beforeSeq?: number },
  ): Promise<HistoryItem[] | null>;
  /** The shop's sites and history removed, one `deleted` event per site, in one transaction; nothing to remove is not an error. */
  abstract deleteByShop(
    shopId: string,
    now: Date,
  ): Promise<{ id: string; publishableKey: string }[]>;
  /** Version-guarded: only sites whose `shopVersion` is lower change; returns their keys for cache invalidation. */
  abstract applyShopCopy(
    shopId: string,
    update: ShopCopyUpdate,
  ): Promise<string[]>;
  /** Backfill support: a page of sites after `afterId`, with the sealed secret and whether its shop copy is still unset. */
  abstract backfillPage(
    afterId: string | null,
    limit: number,
  ): Promise<
    {
      id: string;
      shopId: string;
      identitySecretSealed: string;
      shopVersion: number;
    }[]
  >;
  abstract resealIf(
    siteId: string,
    expectedSealed: string,
    newSealed: string,
  ): Promise<boolean>;
}

export interface ProductFact {
  id: string;
  title: string;
  priceMinor: number;
  currency: string;
  inStock: boolean;
  status: string;
}

/** The catalog through its exported R1 service (`getProductsByIds(ids, {shopId})`): one batch, never a table. */
export abstract class WidgetCatalog {
  abstract productsOfShop(
    shopId: string,
    ids: string[],
  ): Promise<Map<string, ProductFact>>;
}

export interface ShopFact {
  id: string;
  name: string;
  status: string;
  shopVersion: number;
}

/** The tenancy capability through `ShopQueryService.getShopsByIds` (R1): used at creation and by the backfill. */
export abstract class WidgetShops {
  abstract getShops(ids: string[]): Promise<Map<string, ShopFact>>;
}

/** Atomic set-if-absent with expiry: `true` when this call claimed the marker. Throws `SingleUseUnavailable` when the store fails. */
export abstract class SingleUseStore {
  abstract claim(key: string, ttlSeconds: number): Promise<boolean>;
}

export class SingleUseUnavailable extends Error {
  constructor(cause?: unknown) {
    super('single-use store unavailable');
    this.cause = cause;
  }
}

export interface WidgetTokenClaims {
  jti: string;
  siteId: string;
  shopId: string;
  externalCustomerId: string;
  email: string | null;
  issuedAt: number;
  expiresAt: number;
}

/** Signs and verifies widget session tokens with the dedicated key; the clock is passed in. */
export abstract class WidgetTokenSigner {
  abstract sign(input: {
    siteId: string;
    shopId: string;
    externalCustomerId: string;
    email: string | null;
    now: Date;
    lifetimeSeconds: number;
  }): { token: string; claims: WidgetTokenClaims };
  /** `null` for every invalid token: bad signature, type, audience, issuer, expiry. Never throws. */
  abstract verify(token: string, now: Date): WidgetTokenClaims | null;
}

/** HS256 verification of a shop's hand-off token against one secret; the claims policy is applied by the caller. */
export abstract class HandoffVerifier {
  abstract verify(
    token: string,
    secret: string,
  ): Record<string, unknown> | null;
}

export abstract class WidgetRandom {
  /** 128 random bits, base64. */
  abstract nonce(): string;
}
