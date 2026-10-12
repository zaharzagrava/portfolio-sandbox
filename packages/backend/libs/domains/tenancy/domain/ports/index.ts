import type { CrossTenantReason } from '../cross-tenant-reason';
import type { MemberSource, ShopPlan, ShopRole } from '../shop-types';
import type { ShopStatus } from '../shop-status';
import type { VerificationStatus } from '../verification-status';

/**
 * Domain ports (D-6): `api/` and `application/` depend on these tokens; adapters live in `infra/` and are bound in the
 * module. Every lookup of a shop-owned record carries `(shopId, userId)` or `(shopId, id)` (III.4): there is no
 * "load by id, then check" method.
 */
export const SHOP_REPOSITORY = Symbol('SHOP_REPOSITORY');
export const MEMBERSHIP_REPOSITORY = Symbol('MEMBERSHIP_REPOSITORY');
export const INVITE_REPOSITORY = Symbol('INVITE_REPOSITORY');
export const SSO_CONFIG_REPOSITORY = Symbol('SSO_CONFIG_REPOSITORY');
export const DIRECTORY_REPOSITORY = Symbol('DIRECTORY_REPOSITORY');
export const STATUS_HISTORY_REPOSITORY = Symbol('STATUS_HISTORY_REPOSITORY');
export const AUTHZ_CACHE = Symbol('AUTHZ_CACHE');
export const OIDC_DISCOVERY = Symbol('OIDC_DISCOVERY');
export const TENANT_DB_ROLE_CHECK = Symbol('TENANT_DB_ROLE_CHECK');
export const MEMBERSHIP_READER = Symbol('MEMBERSHIP_READER');
export const TENANT_TRANSACTIONS = Symbol('TENANT_TRANSACTIONS');
/** Net options of the outbound requests tenancy makes (SSRF escape hatches for specs only; empty in production). */
export const TENANCY_NET_OPTIONS = Symbol('TENANCY_NET_OPTIONS');

/**
 * Checks a shop's identity provider before it is stored (FR-041): HTTPS to a public address, discovery document
 * answered within 3 s and naming the same issuer. Throws `sso_issuer_invalid|mismatch|unreachable`. Never called
 * inside a transaction.
 */
export interface OidcDiscovery {
  verify(issuer: string): Promise<void>;
}

export interface SsoConfigRecord {
  shopId: string;
  issuer: string;
  clientId: string;
  clientSecretEnc: string;
  defaultRole: 'STAFF' | 'VIEWER';
  enabled: boolean;
  updatedAt: Date;
}

export interface SsoConfigRepository {
  find(shopId: string): Promise<SsoConfigRecord | null>;
  /** Insert or replace; the caller already merged the secret. */
  upsert(input: {
    shopId: string;
    issuer: string;
    clientId: string;
    clientSecretEnc: string;
    defaultRole: 'STAFF' | 'VIEWER';
    now: Date;
  }): Promise<SsoConfigRecord>;
  /** `false` when there was nothing to delete. */
  delete(shopId: string): Promise<boolean>;
  /** Rows sealed without a context (`v1.`), at most `limit`, across shops (cross-tenant). */
  listLegacySealed(limit: number): Promise<SsoConfigRecord[]>;
  /** Replaces the sealed secret only while it still is `from` (a concurrent edit wins). */
  replaceSealed(shopId: string, from: string, to: string): Promise<boolean>;
}

/** Startup check that the application role cannot bypass row-level security (FR-053). Throws in production. */
export interface TenantDbRoleCheck {
  verify(): Promise<void>;
}

/** Transactions that carry the row-level-security context; implemented by `infra/shop-transaction.ts`. */
export interface TenantTransactions {
  inShop<T>(
    shopId: string,
    fn: () => Promise<T>,
    options?: { userId?: string },
  ): Promise<T>;
  asUser<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  crossTenant<T>(reason: CrossTenantReason, fn: () => Promise<T>): Promise<T>;
}

export interface ShopRecord {
  id: string;
  slug: string;
  name: string;
  plan: ShopPlan;
  planVersion: number;
  status: ShopStatus;
  purgeAt: Date | null;
  shopVersion: number;
  verificationStatus: VerificationStatus;
  payoutsEnabled: boolean;
  sandboxOf: string | null;
  region: string;
  createdAt: Date;
}

export interface ShopListRow {
  id: string;
  name: string;
  slug: string;
  plan: ShopPlan;
  status: ShopStatus;
  role: ShopRole;
  joinedAt: Date;
  /** The membership's `createdAt` at full database precision, as text: half of the keyset cursor. */
  cursorKey: string;
}

export interface ShopRepository {
  /** `null` when the slug is taken (`ON CONFLICT DO NOTHING`): inside the transaction a raised violation would abort it. */
  insert(input: {
    id: string;
    name: string;
    slug: string;
    region: string;
    now: Date;
    /** Set for a sandbox shop: the live shop it mirrors. */
    sandboxOf?: string;
  }): Promise<ShopRecord | null>;
  findById(shopId: string): Promise<ShopRecord | null>;
  findBySlug(slug: string): Promise<ShopRecord | null>;
  findSandboxOf(liveShopId: string): Promise<ShopRecord | null>;
  /** One query, duplicates collapsed, unknown ids absent. */
  findByIds(ids: string[]): Promise<ShopRecord[]>;
  /** The shop row locked for the transaction (seat counting, status changes). */
  lockById(shopId: string): Promise<ShopRecord | null>;
  /** Name change with `shopVersion + 1`; `null` when the shop is gone. */
  patchName(
    shopId: string,
    name: string,
    now: Date,
  ): Promise<ShopRecord | null>;
  /**
   * Sets the plan when `version` is newer than the stored `planVersion` (bumps `shopVersion`); `null` when the shop is
   * gone or the version is not newer.
   */
  applyPlan(
    shopId: string,
    plan: ShopPlan,
    version: number,
    now: Date,
  ): Promise<ShopRecord | null>;
  /**
   * Status change conditional on the status the caller read (`WHERE status = from`), `shopVersion + 1`; `purgeAt` is
   * set to the given value (null clears it). `null` when somebody else changed the status first.
   */
  transition(input: {
    shopId: string;
    from: ShopStatus;
    to: ShopStatus;
    purgeAt: Date | null;
    now: Date;
  }): Promise<ShopRecord | null>;
  /** Verification fields and `shopVersion + 1`; `null` when the shop is gone. */
  setVerification(
    shopId: string,
    status: VerificationStatus,
    payoutsEnabled: boolean,
    now: Date,
  ): Promise<ShopRecord | null>;
  /** `DELETING` → tombstone `{DELETED, "[deleted]", deleted-<id>, purgeAt null}`; `null` unless it was `DELETING`. */
  tombstone(shopId: string, now: Date): Promise<ShopRecord | null>;
  /** Ids of closing shops whose `purgeAt` has passed, oldest first. */
  listDueForPurge(now: Date, limit: number): Promise<string[]>;
  /** Serialises shop creation per user (transaction-scoped advisory lock). */
  lockOwnerCreation(userId: string): Promise<void>;
  countOwnedBy(userId: string): Promise<number>;
  /** The shops of a user in membership order; sandbox shops excluded; keyset (joinedAt, shopId). */
  listForUser(
    userId: string,
    after: { key: string; id: string } | null,
    limit: number,
  ): Promise<ShopListRow[]>;
}

export interface MemberRow {
  userId: string;
  role: ShopRole;
  source: MemberSource;
  joinedAt: Date;
  cursorKey: string;
}

export interface MembershipRepository {
  /** `false` when the user already is a member (no overwrite, no raise). */
  insert(input: {
    shopId: string;
    userId: string;
    role: ShopRole;
    source: MemberSource;
    now: Date;
  }): Promise<boolean>;
  find(shopId: string, userId: string): Promise<MemberRow | null>;
  /** The page after `(joinedAt, userId)`. */
  listPage(
    shopId: string,
    after: { key: string; id: string } | null,
    limit: number,
  ): Promise<MemberRow[]>;
  count(shopId: string): Promise<number>;
  countOwners(shopId: string): Promise<number>;
  /** Conditional on the role the caller read; `false` when it changed meanwhile. */
  updateRole(
    shopId: string,
    userId: string,
    from: ShopRole,
    to: ShopRole,
  ): Promise<boolean>;
  delete(shopId: string, userId: string, role: ShopRole): Promise<boolean>;
  /** Every member of the shop, oldest first (purge and export; a shop has at most 250 seats). */
  listAll(shopId: string): Promise<MemberRow[]>;
  /** Removes every member of the shop; returns how many. */
  deleteAll(shopId: string): Promise<number>;
  /** One query for many shops, order `(shopId, createdAt, userId)`. */
  listByShopIds(
    shopIds: string[],
    roles?: ShopRole[],
  ): Promise<Array<{ shopId: string; userId: string; role: ShopRole }>>;
}

export interface InviteRecord {
  id: string;
  shopId: string;
  email: string;
  role: Exclude<ShopRole, 'OWNER'>;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  cursorKey: string;
}

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InviteRepository {
  /** `null` when a pending invite for the address exists (partial unique index). */
  insert(input: {
    shopId: string;
    email: string;
    role: InviteRecord['role'];
    tokenHash: string;
    invitedBy: string;
    expiresAt: Date;
    now: Date;
  }): Promise<InviteRecord | null>;
  find(shopId: string, id: string): Promise<InviteRecord | null>;
  /** The pending (not accepted, not revoked) invite for the address, expired ones included. */
  findPendingByEmail(
    shopId: string,
    email: string,
  ): Promise<InviteRecord | null>;
  /** Unexpired pending invites (seats). */
  countPending(shopId: string, now: Date): Promise<number>;
  /** Only while pending; `false` when somebody else won. */
  revoke(shopId: string, id: string, now: Date): Promise<boolean>;
  /** New token and expiry on a still-pending invite. */
  renew(
    shopId: string,
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<boolean>;
  listPage(
    shopId: string,
    status: InviteStatus | null,
    now: Date,
    after: { key: string; id: string } | null,
    limit: number,
  ): Promise<InviteRecord[]>;
  /** Looks across shops by digest (cross-tenant, `invite.accept`). */
  findByTokenHash(tokenHash: string): Promise<InviteRecord | null>;
  /** The single winner: conditional on pending and unexpired. */
  markAccepted(id: string, userId: string, now: Date): Promise<boolean>;
  /** Every invite of the shop (purge removes them with their addresses). */
  deleteAllForShop(shopId: string): Promise<number>;
  /**
   * Deletes up to `limit` invites whose last event (revocation, acceptance, else expiry) is older than `before`,
   * across shops (cross-tenant); returns how many.
   */
  deleteSettledBefore(before: Date, limit: number): Promise<number>;
}

export interface DirectoryRecord {
  shopId: string;
  cell: string;
  region: string;
  version: number;
}

export interface DirectoryRepository {
  insert(
    shopId: string,
    cell: string,
    region: string,
    now: Date,
  ): Promise<void>;
  find(shopId: string): Promise<DirectoryRecord | null>;
  delete(shopId: string): Promise<void>;
  /** Conditional on `version = expectedVersion` (then `version + 1`); `null` when somebody else moved it first. */
  move(input: {
    shopId: string;
    expectedVersion: number;
    cell: string;
    region: string;
    now: Date;
  }): Promise<DirectoryRecord | null>;
}

export interface StatusHistoryRepository {
  insert(input: {
    shopId: string;
    from: ShopStatus | null;
    to: ShopStatus;
    actor: string;
    reason: string | null;
    at: Date;
  }): Promise<void>;
  /** Purge removes the trail with the rest of the shop's data (it names the acting users). */
  deleteAll(shopId: string): Promise<void>;
}

/** What the guard and `ShopAccessService` need: role and shop status, with the principal in the predicate. */
export interface MembershipReader {
  read(
    shopId: string,
    userId: string,
  ): Promise<{ role: ShopRole; status: ShopStatus } | null>;
}

export interface AuthzCacheEntry {
  role: ShopRole;
  status: ShopStatus;
}

export type AuthzCacheRead =
  /** `value: null` is a cached "not a member". */
  | { state: 'hit'; value: AuthzCacheEntry | null }
  | { state: 'miss' }
  /** The store is unreachable or the entry unreadable: the caller falls back to the database. */
  | { state: 'down' };

export interface AuthzCache {
  get(shopId: string, userId: string): Promise<AuthzCacheRead>;
  /** Never throws. */
  set(
    shopId: string,
    userId: string,
    value: AuthzCacheEntry | null,
  ): Promise<void>;
  /** Drops one entry (member write) or every entry of the shop (status change). Never throws. */
  delete(shopId: string, userId?: string): Promise<void>;
}
