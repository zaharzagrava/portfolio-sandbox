import { Inject, Injectable } from '@nestjs/common';
import { afterCommit } from '@app/infrastructure/context';
import {
  AUTHZ_CACHE,
  MEMBERSHIP_READER,
  TENANT_TRANSACTIONS,
  type AuthzCache,
  type MembershipReader,
  type TenantTransactions,
} from '../domain/ports';
import {
  can,
  SENSITIVE_PERMISSIONS,
  type ShopPermission,
} from '../domain/permissions';
import type { ShopRole } from '../domain/shop-types';
import type { ShopStatus } from '../domain/shop-status';
import {
  Domain_PermissionDeniedError,
  Domain_ShopNotFoundError,
  Domain_ShopOffboardingError,
  Domain_ShopSuspendedError,
} from '../domain/errors';
import {
  authzCacheCounter,
  authzDeniedCounter,
} from '../domain/tenancy-metrics';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** FR-013: what a closed shop still allows. */
const WHILE_SUSPENDED: readonly ShopPermission[] = [
  'shop.read',
  'members.read',
  'shop.export',
];
const WHILE_DELETING: readonly ShopPermission[] = [
  ...WHILE_SUSPENDED,
  'shop.delete',
];

export interface ResolvedAccess {
  role: ShopRole;
  status: ShopStatus;
}

/**
 * Authorization of a principal in a shop (R1, FR-010 to FR-015). Answer order: not found (not a member, unknown,
 * malformed, deleted: indistinguishable), then `permission_denied`, then the status gate. Non-sensitive permissions
 * may come from the shared cache (at most 15 s old); sensitive ones always read the database. The cache is never the
 * source of truth and an outage falls back to the database.
 */
@Injectable()
export class ShopAccessService {
  constructor(
    @Inject(MEMBERSHIP_READER) private readonly reader: MembershipReader,
    @Inject(AUTHZ_CACHE) private readonly cache: AuthzCache,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
  ) {}

  /** Throws not-found, forbidden, suspended or offboarding; returns the caller's role otherwise. */
  async assertMember(
    shopId: string,
    userId: string,
    permission?: ShopPermission,
  ): Promise<{ role: ShopRole }> {
    const access = await this.resolve(shopId, userId, permission);
    return { role: access.role };
  }

  /** The role, or `null` for a non-member, unknown, malformed or deleted shop. No permission or status gate. */
  async getRole(shopId: string, userId: string): Promise<ShopRole | null> {
    const entry = await this.lookup(shopId, userId, false);
    return entry && entry.status !== 'DELETED' ? entry.role : null;
  }

  async resolve(
    shopId: string,
    userId: string,
    permission?: ShopPermission,
  ): Promise<ResolvedAccess> {
    const strong =
      permission !== undefined && SENSITIVE_PERMISSIONS.includes(permission);
    const entry = await this.lookup(shopId, userId, strong);
    if (!entry || entry.status === 'DELETED') {
      authzDeniedCounter.add(1, { reason: 'not_member' });
      throw new Domain_ShopNotFoundError();
    }
    if (permission && !can(entry.role, permission)) {
      authzDeniedCounter.add(1, { reason: 'permission' });
      throw new Domain_PermissionDeniedError();
    }
    if (permission) this.gate(entry.status, permission);
    return entry;
  }

  /** May the user follow the shop's live topic? Members of `ACTIVE`/`SUSPENDED` shops; always a database read. */
  async mayFollowLiveTopic(shopId: string, userId: string): Promise<boolean> {
    const entry = await this.lookup(shopId, userId, true);
    return entry?.status === 'ACTIVE' || entry?.status === 'SUSPENDED';
  }

  /** Member writers call this inside their transaction: the entry goes after commit, never before. */
  invalidateAfterCommit(shopId: string, userId?: string): void {
    afterCommit(() => this.cache.delete(shopId, userId));
  }

  private gate(status: ShopStatus, permission: ShopPermission): void {
    if (status === 'SUSPENDED' && !WHILE_SUSPENDED.includes(permission)) {
      authzDeniedCounter.add(1, { reason: 'status' });
      throw new Domain_ShopSuspendedError();
    }
    if (status === 'DELETING' && !WHILE_DELETING.includes(permission)) {
      authzDeniedCounter.add(1, { reason: 'status' });
      throw new Domain_ShopOffboardingError();
    }
  }

  private async lookup(
    shopId: string,
    userId: string,
    strong: boolean,
  ): Promise<ResolvedAccess | null> {
    if (!UUID.test(shopId) || !UUID.test(userId)) return null;
    if (strong) {
      authzCacheCounter.add(1, { result: 'strong' });
      return this.read(shopId, userId);
    }
    const cached = await this.cache.get(shopId, userId);
    if (cached.state === 'hit') {
      authzCacheCounter.add(1, { result: 'hit' });
      return cached.value;
    }
    authzCacheCounter.add(1, {
      result: cached.state === 'down' ? 'fallback' : 'miss',
    });
    const fresh = await this.read(shopId, userId);
    if (cached.state === 'miss') await this.cache.set(shopId, userId, fresh);
    return fresh;
  }

  private read(shopId: string, userId: string): Promise<ResolvedAccess | null> {
    return this.shopTx.inShop(shopId, () => this.reader.read(shopId, userId), {
      userId,
    });
  }
}
