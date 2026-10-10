import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, Clock } from '@app/common/core/clock';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  DIRECTORY_REPOSITORY,
  MEMBERSHIP_REPOSITORY,
  SHOP_REPOSITORY,
  STATUS_HISTORY_REPOSITORY,
  TENANT_TRANSACTIONS,
  type DirectoryRepository,
  type MembershipRepository,
  type ShopRecord,
  type ShopRepository,
  type StatusHistoryRepository,
  type TenantTransactions,
} from '../domain/ports';
import { MemberAdded, ShopCreated } from '../domain/events';
import {
  Domain_InvalidQueryError,
  Domain_ShopNotFoundError,
  Domain_TooManyIdsError,
} from '../domain/errors';
import { provisionedCounter } from '../domain/tenancy-metrics';
import { toShopSummary, type ShopSummaryDto } from './shop-summary';

export const LEGACY_BATCH_MAX = 200;
const DEFAULT_REGION = 'eu-central-1';

/**
 * Shops created for other capabilities (R1, FR-055): the legacy sellers they back-fill, and sandbox shops. Both are
 * idempotent, whole-batch atomic and safe to call concurrently; they run under the audited `legacy.provision` bypass
 * because no shop context exists yet.
 */
@Injectable()
export class ShopProvisioningService {
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
    private readonly outbox: OutboxService,
  ) {}

  /** `seller-<id>` shop with the seller as `provisioned` owner. Returns seller id → shop id for every distinct id. */
  async ensureShopsForLegacySellers(
    sellerIds: string[],
  ): Promise<Map<string, string>> {
    const distinct = [...new Set(sellerIds)];
    if (distinct.length > LEGACY_BATCH_MAX)
      throw new Domain_TooManyIdsError(LEGACY_BATCH_MAX);
    // Always in the same order, so two concurrent batches queue on the unique slug instead of deadlocking.
    const ordered = [...distinct].sort();

    const byseller = await this.shopTx.crossTenant(
      'legacy.provision',
      async () => {
        const result = new Map<string, string>();
        for (const sellerId of ordered) {
          const slug = `seller-${sellerId}`;
          const id = uuidv7();
          const now = this.clock.now();
          const created = await this.shops.insert({
            id,
            name: `Seller ${sellerId.slice(0, 8)}`,
            slug,
            region: DEFAULT_REGION,
            now,
          });
          if (!created) {
            const existing = await this.shops.findBySlug(slug);
            if (!existing)
              throw new Error(`shop ${slug} vanished while provisioning`);
            result.set(sellerId, existing.id);
            provisionedCounter.add(1, { outcome: 'legacy_existing' });
            continue;
          }
          await this.directory.insert(id, 'pooled', DEFAULT_REGION, now);
          await this.members.insert({
            shopId: id,
            userId: sellerId,
            role: 'OWNER',
            source: 'provisioned',
            now,
          });
          await this.history.insert({
            shopId: id,
            from: null,
            to: 'ACTIVE',
            actor: 'system',
            reason: 'legacy.provision',
            at: now,
          });
          await this.outbox.append([
            ShopCreated.create(id, created.shopVersion, {
              shopId: id,
              ownerId: sellerId,
              name: created.name,
              slug,
              plan: created.plan,
              region: DEFAULT_REGION,
              shopVersion: created.shopVersion,
            }),
            MemberAdded.create(id, created.shopVersion, {
              shopId: id,
              userId: sellerId,
              role: 'OWNER',
              source: 'provisioned',
            }),
          ]);
          result.set(sellerId, id);
          provisionedCounter.add(1, { outcome: 'legacy_created' });
        }
        return result;
      },
    );
    return new Map(distinct.map((id) => [id, byseller.get(id)!]));
  }

  /** The one sandbox shop of a live shop: `<slug>-sandbox`, no members, `sandboxOf` set. */
  async ensureSandboxShop(liveShopId: string): Promise<ShopSummaryDto> {
    const sandbox = await this.shopTx.crossTenant(
      'legacy.provision',
      async () => {
        const live = await this.shops.findById(liveShopId);
        if (!live || live.status === 'DELETED')
          throw new Domain_ShopNotFoundError();
        if (live.sandboxOf !== null)
          throw new Domain_InvalidQueryError(
            'liveShopId',
            'sandbox_of_sandbox',
          );
        const existing = await this.shops.findSandboxOf(live.id);
        if (existing) return existing;

        const id = uuidv7();
        const now = this.clock.now();
        const created: ShopRecord | null = await this.shops.insert({
          id,
          name: `${live.name} (sandbox)`,
          slug: `${live.slug}-sandbox`,
          region: live.region,
          now,
          sandboxOf: live.id,
        });
        if (!created) {
          // Another caller won the race for the same sandbox: converge on its row.
          const winner = await this.shops.findSandboxOf(live.id);
          if (!winner)
            throw new Error(`sandbox of ${live.id} could not be created`);
          return winner;
        }
        await this.directory.insert(id, 'pooled', live.region, now);
        await this.history.insert({
          shopId: id,
          from: null,
          to: 'ACTIVE',
          actor: 'system',
          reason: 'sandbox.provision',
          at: now,
        });
        await this.outbox.append(
          ShopCreated.create(id, created.shopVersion, {
            shopId: id,
            ownerId: null,
            name: created.name,
            slug: created.slug,
            plan: created.plan,
            region: live.region,
            shopVersion: created.shopVersion,
          }),
        );
        provisionedCounter.add(1, { outcome: 'sandbox_created' });
        return created;
      },
    );
    return toShopSummary(sandbox);
  }
}
