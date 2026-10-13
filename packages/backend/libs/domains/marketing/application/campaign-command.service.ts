import { Inject, Injectable } from '@nestjs/common';
import {
  budgetBelowCpc,
  type AdAction,
  type AdCampaign,
  type CreateAdCampaignRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  CAMPAIGN_STORE,
  CATALOG_PORT,
  OpenCampaignExistsError,
  PRODUCT_SNAPSHOT_STORE,
  SHOP_DIRECTORY_PORT,
  SHOP_SNAPSHOT_STORE,
  type CampaignRecord,
  type CampaignStore,
  type CatalogPort,
  type ProductSnapshotStore,
  type ShopDirectoryPort,
  type ShopSnapshotStore,
} from '../domain/ads-ports';
import * as errors from '../domain/ads-errors';
import { nextStatus } from '../domain/campaign-state';
import { CampaignLifecycleService } from './campaign-lifecycle.service';
import { CampaignCreated } from './events/ads-events';
import { toCampaignDto, toEventPayload } from './campaign-view';

/** A command is a short unit of work: bounded lock waits and statements (R-19). */
export const COMMAND_TX = { lockTimeoutMs: 2_000, statementTimeoutMs: 5_000 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Campaign commands (US1): create, pause, resume, end. Each is one `TransactionRunner.run` that writes the campaign, its
 * history row, the per-shop quota, the product's sponsored value and the outbox events together (R-3, AS-75). The R1
 * lookups that seed the read models run before the transaction: no network call inside it. Invariants sit in the store
 * (unique index, conditional quota, conditional transition), so racing requests yield exactly one winner.
 */
@Injectable()
export class CampaignCommandService {
  constructor(
    @Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore,
    @Inject(PRODUCT_SNAPSHOT_STORE)
    private readonly productSnapshots: ProductSnapshotStore,
    @Inject(SHOP_SNAPSHOT_STORE)
    private readonly shopSnapshots: ShopSnapshotStore,
    @Inject(CATALOG_PORT) private readonly catalog: CatalogPort,
    @Inject(SHOP_DIRECTORY_PORT) private readonly shops: ShopDirectoryPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly transactions: TransactionRunner,
    private readonly lifecycle: CampaignLifecycleService,
  ) {}

  async create(
    shopId: string,
    actorId: string,
    request: CreateAdCampaignRequest,
  ): Promise<AdCampaign> {
    if (budgetBelowCpc(request)) throw errors.budgetBelowCpc();

    // R1 lookups first (FR-060): ownership and category of the product, and the shop's state for its read model.
    const product = await this.catalog.getShopProduct(
      request.productId,
      shopId,
    );
    if (!product) throw errors.productNotFound();
    if (product.status !== 'ACTIVE' || product.isSandbox)
      throw errors.productNotSponsorable();
    const shop = await this.shops.getShop(shopId);
    if (!shop) throw errors.shopNotFound();

    const campaign = await this.transactions.run(async () => {
      const now = this.clock.now();
      let created: CampaignRecord;
      try {
        created = await this.campaigns.insert(
          {
            shopId,
            productId: product.id,
            category: product.category,
            cpcMinor: request.cpcMinor,
            dailyBudgetMinor: request.dailyBudgetMinor,
          },
          now,
        );
      } catch (error) {
        if (error instanceof OpenCampaignExistsError)
          throw errors.campaignAlreadyExists();
        throw error;
      }
      if (!(await this.campaigns.reserveQuota(shopId)))
        throw errors.campaignLimitReached();
      await this.campaigns.appendHistory(
        {
          campaignId: created.id,
          actorId,
          from: null,
          to: 'ACTIVE',
          reason: 'created',
          campaignVersion: created.campaignVersion,
        },
        now,
      );
      // Read models seeded from the R1 lookups (AS-74): served at once, an older event arriving later is ignored.
      await this.productSnapshots.upsertIfNewer(
        {
          productId: product.id,
          shopId,
          title: product.title,
          category: product.category,
          priceMinor: product.priceMinor,
          currency: product.currency,
          inStock: product.inStock,
          status: product.status,
          isSandbox: product.isSandbox,
          productVersion: product.productVersion,
        },
        now,
      );
      await this.shopSnapshots.upsertIfNewer(
        {
          shopId,
          status: shop.status,
          offboarding: shop.status === 'DELETING',
          deleted: shop.status === 'DELETED',
          shopVersion: shop.shopVersion,
        },
        now,
      );
      const events: EventEnvelope[] = [
        CampaignCreated.create(
          created.id,
          created.campaignVersion,
          toEventPayload(created),
          now,
        ),
      ];
      await this.lifecycle.publishSponsorship(created, true, now, events);
      await this.outbox.append(events);
      return created;
    }, COMMAND_TX);
    return toCampaignDto(campaign);
  }

  /** `pause`, `resume` or `end` by a member (the route's permission is `shop.manage`). */
  async transition(
    shopId: string,
    campaignId: string,
    action: AdAction,
    actorId: string,
  ): Promise<AdCampaign> {
    if (!UUID.test(campaignId)) throw errors.campaignNotFound();
    const found = await this.campaigns.findForShop(campaignId, shopId);
    if (!found) throw errors.campaignNotFound();
    if (nextStatus(found.status, action) === null)
      throw errors.invalidTransition(found.status, action);
    if (action === 'resume') await this.assertCanResume(found);

    const updated = await this.transactions.run(
      () =>
        this.lifecycle.apply(found, action, {
          actorId,
          reason: `seller_${action}`,
          statusReason: 'seller',
        }),
      COMMAND_TX,
    );
    if (!updated) {
      // A racing request changed the campaign between the read and the update: report the state it is in now.
      const now = await this.campaigns.findForShop(campaignId, shopId);
      throw errors.invalidTransition(now?.status ?? found.status, action);
    }
    return toCampaignDto(updated);
  }

  /** AS-72: a campaign does not resume while its product is unavailable or its shop is not active. */
  private async assertCanResume(campaign: CampaignRecord): Promise<void> {
    const product = await this.productSnapshots.find(campaign.productId);
    if (!product || product.status !== 'ACTIVE')
      throw errors.productUnavailable();
    const shop = await this.shopSnapshots.find(campaign.shopId);
    if (!shop || shop.status !== 'ACTIVE' || shop.offboarding || shop.deleted)
      throw errors.shopInactive();
  }
}
