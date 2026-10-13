import { Inject, Injectable } from '@nestjs/common';
import type {
  AdCampaignDetail,
  AdCampaignPage,
  AdCampaignStatus,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  BILLING_STORE,
  CAMPAIGN_STORE,
  type BillingStore,
  type CampaignStore,
} from '../domain/ads-ports';
import { decodeCursor, encodeCursor } from '../domain/ads-cursor';
import { campaignNotFound } from '../domain/ads-errors';
import { dayKey, dayStart } from '../domain/click-record';
import { toCampaignDto } from './campaign-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads of the advertiser's own campaigns (US1). The shop is in every predicate (FR-003): another shop's campaign is
 * absent, with the same answer as an unknown one. The list is keyset-paged newest first by a signed cursor bound to the
 * shop (FR-006). `billedTodayMinor` comes from posted charges only, never an estimate (FR-059).
 */
@Injectable()
export class CampaignQueryService {
  constructor(
    @Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore,
    @Inject(BILLING_STORE) private readonly billing: BillingStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async list(
    shopId: string,
    query: { status?: AdCampaignStatus; limit: number; cursor?: string },
  ): Promise<AdCampaignPage> {
    const key = this.config.get('jwt_secret');
    const after = query.cursor
      ? (() => {
          const fields = decodeCursor(key, shopId, query.cursor!);
          return { createdAt: fields.c, id: fields.k };
        })()
      : undefined;
    const rows = await this.campaigns.list(shopId, {
      status: query.status,
      limit: query.limit + 1,
      after,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toCampaignDto),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(key, shopId, {
              c: last.createdAt.toISOString(),
              k: last.id,
            })
          : null,
    };
  }

  async get(shopId: string, campaignId: string): Promise<AdCampaignDetail> {
    const campaign = await this.find(shopId, campaignId);
    const billedTodayMinor = await this.billing.netChargedInDay(
      campaign.id,
      dayStart(dayKey(this.clock.now())),
    );
    return { ...toCampaignDto(campaign), billedTodayMinor };
  }

  /** Used by the statement too: an unknown or foreign id is `404 campaign_not_found`. */
  async find(shopId: string, campaignId: string) {
    if (!UUID.test(campaignId)) throw campaignNotFound();
    const campaign = await this.campaigns.findForShop(campaignId, shopId);
    if (!campaign) throw campaignNotFound();
    return campaign;
  }
}
