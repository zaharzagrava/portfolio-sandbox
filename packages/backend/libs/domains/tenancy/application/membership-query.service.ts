import { Inject, Injectable } from '@nestjs/common';
import { UserDirectoryService } from '@app/domains/identity';
import {
  MEMBERSHIP_REPOSITORY,
  TENANT_TRANSACTIONS,
  type MembershipRepository,
  type TenantTransactions,
} from '../domain/ports';
import {
  Domain_InvalidQueryError,
  Domain_TooManyIdsError,
} from '../domain/errors';
import { decodeKeyset, encodeKeyset, parseLimit } from '../domain/cursor';
import type { ShopRole } from '../domain/shop-types';

export const MEMBERSHIP_QUERY_MAX_IDS = 500;

/** Reads of membership: the team page of one shop (FR-005). Addresses come from identity in one batched call. */
@Injectable()
export class MembershipQueryService {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY)
    private readonly members: MembershipRepository,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
    private readonly directory: UserDirectoryService,
  ) {}

  /**
   * Members of many shops in one query, ordered `(shopId, createdAt, userId)`, optionally only some roles (R1). A batch
   * across shops has no single shop context, so it runs under the audited `membership.mine` bypass.
   */
  async getMembersByShopIds(
    shopIds: string[],
    roles?: ShopRole[],
  ): Promise<Map<string, Array<{ userId: string; role: ShopRole }>>> {
    const unique = [...new Set(shopIds)];
    if (unique.length > MEMBERSHIP_QUERY_MAX_IDS)
      throw new Domain_TooManyIdsError(MEMBERSHIP_QUERY_MAX_IDS);
    const rows = await this.shopTx.crossTenant('membership.mine', () =>
      this.members.listByShopIds(unique, roles),
    );
    const out = new Map<string, Array<{ userId: string; role: ShopRole }>>();
    for (const row of rows) {
      const list = out.get(row.shopId) ?? [];
      list.push({ userId: row.userId, role: row.role });
      out.set(row.shopId, list);
    }
    return out;
  }

  async list(
    shopId: string,
    viewerId: string,
    query: { limit?: string; cursor?: string },
  ) {
    const limit = parseLimit(query.limit);
    if (limit === null)
      throw new Domain_InvalidQueryError('limit', 'invalid_limit');
    let after: { key: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      after = decodeKeyset(query.cursor);
      if (!after)
        throw new Domain_InvalidQueryError('cursor', 'invalid_cursor');
    }
    const rows = await this.shopTx.inShop(
      shopId,
      () => this.members.listPage(shopId, after, limit + 1),
      { userId: viewerId },
    );
    const page = rows.slice(0, limit);
    const users = await this.directory.getUsersByIds(page.map((m) => m.userId));
    const last = page[page.length - 1];
    return {
      items: page.map((m) => ({
        userId: m.userId,
        email: users.get(m.userId)?.email ?? null,
        role: m.role,
        source: m.source,
        joinedAt: m.joinedAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeKeyset(last.cursorKey, last.userId)
          : null,
    };
  }
}
