import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  DIRECTORY_REPOSITORY,
  MEMBERSHIP_REPOSITORY,
  SHOP_REPOSITORY,
  STATUS_HISTORY_REPOSITORY,
  TENANT_TRANSACTIONS,
  type DirectoryRepository,
  type MembershipRepository,
  type ShopRepository,
  type StatusHistoryRepository,
  type TenantTransactions,
} from '../domain/ports';
import { MemberAdded, ShopCreated, ShopUpdated } from '../domain/events';
import {
  Domain_InvalidQueryError,
  Domain_RegionNotAllowedError,
  Domain_ShopLimitReachedError,
  Domain_ShopNotFoundError,
  Domain_SlugReservedError,
  Domain_SlugTakenError,
} from '../domain/errors';
import { decodeKeyset, encodeKeyset, parseLimit } from '../domain/cursor';
import { checkSlug } from '../domain/slug-policy';
import { MAX_OWNED_SHOPS } from '../domain/seat-policy';
import type { ShopRole } from '../domain/shop-types';
import { toShopDto } from './shop.mapper';
import { TenancyAudit } from './tenancy-observability';

export const DEFAULT_REGIONS = ['eu-central-1', 'us-east-1'];

/** Creating, reading and renaming shops (FR-001 to FR-005). One transaction per mutation, event in the same one. */
@Injectable()
export class ShopService {
  constructor(
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
    @Inject(MEMBERSHIP_REPOSITORY)
    private readonly members: MembershipRepository,
    @Inject(DIRECTORY_REPOSITORY)
    private readonly directory: DirectoryRepository,
    @Inject(STATUS_HISTORY_REPOSITORY)
    private readonly history: StatusHistoryRepository,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly config: ApiConfigService,
    private readonly audit: TenancyAudit,
  ) {}

  /** Shop, OWNER membership, pooled directory entry, history row and events, atomically; writes nothing of identity's. */
  async create(
    ownerId: string,
    input: { name: string; slug: string; region?: string },
  ) {
    const slugCheck = checkSlug(input.slug);
    if (slugCheck === 'invalid')
      throw new Domain_InvalidQueryError('slug', 'invalid_slug');
    if (slugCheck === 'reserved') throw new Domain_SlugReservedError();
    const regions = this.regions();
    const region = input.region ?? regions[0];
    if (!regions.includes(region)) throw new Domain_RegionNotAllowedError();

    const id = uuidv7();
    const shop = await this.shopTx.inShop(
      id,
      async () => {
        await this.shops.lockOwnerCreation(ownerId);
        if ((await this.shops.countOwnedBy(ownerId)) >= MAX_OWNED_SHOPS)
          throw new Domain_ShopLimitReachedError();
        const now = this.clock.now();
        const created = await this.shops.insert({
          id,
          name: input.name,
          slug: input.slug,
          region,
          now,
        });
        if (!created) throw new Domain_SlugTakenError();
        await this.directory.insert(id, 'pooled', region, now);
        await this.members.insert({
          shopId: id,
          userId: ownerId,
          role: 'OWNER',
          source: 'owner',
          now,
        });
        await this.history.insert({
          shopId: id,
          from: null,
          to: 'ACTIVE',
          actor: ownerId,
          reason: null,
          at: now,
        });
        await this.outbox.append([
          ShopCreated.create(id, created.shopVersion, {
            shopId: id,
            ownerId,
            name: created.name,
            slug: created.slug,
            plan: created.plan,
            region,
            shopVersion: created.shopVersion,
          }),
          MemberAdded.create(id, created.shopVersion, {
            shopId: id,
            userId: ownerId,
            role: 'OWNER',
            source: 'owner',
          }),
        ]);
        return created;
      },
      { userId: ownerId },
    );
    this.audit.record('shop.created', { shopId: id, actorId: ownerId });
    return toShopDto(shop, 'OWNER');
  }

  /** The caller proved membership in the guard; `role` is what it resolved. */
  async get(shopId: string, role: ShopRole) {
    const shop = await this.shops.findById(shopId);
    if (!shop || shop.status === 'DELETED')
      throw new Domain_ShopNotFoundError();
    return toShopDto(shop, role);
  }

  async rename(shopId: string, actorId: string, name: string, role: ShopRole) {
    const shop = await this.shopTx.inShop(
      shopId,
      async () => {
        const updated = await this.shops.patchName(
          shopId,
          name,
          this.clock.now(),
        );
        if (!updated) throw new Domain_ShopNotFoundError();
        await this.outbox.append(
          ShopUpdated.create(shopId, updated.shopVersion, {
            shopId,
            name: updated.name,
            slug: updated.slug,
            shopVersion: updated.shopVersion,
          }),
        );
        return updated;
      },
      { userId: actorId },
    );
    this.audit.record('shop.updated', { shopId, actorId });
    return toShopDto(shop, role);
  }

  /** "My shops" (FR-005): keyset pages in membership order; sandbox and deleted shops are not listed. */
  async mine(
    userId: string,
    query: { limit?: string; cursor?: string },
  ): Promise<{
    items: Array<{
      id: string;
      name: string;
      slug: string;
      plan: string;
      status: string;
      role: ShopRole;
    }>;
    nextCursor: string | null;
  }> {
    const limit = parseLimit(query.limit);
    if (limit === null)
      throw new Domain_InvalidQueryError('limit', 'invalid_limit');
    let after: { key: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      after = decodeKeyset(query.cursor);
      if (!after)
        throw new Domain_InvalidQueryError('cursor', 'invalid_cursor');
    }
    const rows = await this.shopTx.asUser(userId, () =>
      this.shops.listForUser(userId, after, limit + 1),
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        plan: r.plan,
        status: r.status,
        role: r.role,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeKeyset(last.cursorKey, last.id)
          : null,
    };
  }

  private regions(): string[] {
    const configured = this.config.get('tenancy_regions');
    const list = (configured ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    return list.length > 0 ? list : DEFAULT_REGIONS;
  }
}
