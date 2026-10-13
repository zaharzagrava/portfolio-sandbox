import type {
  AdCampaign,
  AdCampaignEventPayload,
} from '@marketplace-sandbox/contracts';
import type { CampaignRecord } from '../domain/ads-ports';

/** The campaign as the HTTP contract shows it (`adCampaignSchema`): ISO instants, no store detail. */
export const toCampaignDto = (c: CampaignRecord): AdCampaign => ({
  id: c.id,
  shopId: c.shopId,
  productId: c.productId,
  category: c.category,
  cpcMinor: c.cpcMinor,
  dailyBudgetMinor: c.dailyBudgetMinor,
  currency: c.currency,
  status: c.status,
  statusReason: c.statusReason,
  campaignVersion: c.campaignVersion,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

/** The full campaign state as the `marketing.campaign_*` events carry it. */
export const toEventPayload = (c: CampaignRecord): AdCampaignEventPayload => ({
  campaignId: c.id,
  shopId: c.shopId,
  productId: c.productId,
  category: c.category,
  cpcMinor: c.cpcMinor,
  dailyBudgetMinor: c.dailyBudgetMinor,
  status: c.status,
  statusReason: c.statusReason,
  campaignVersion: c.campaignVersion,
});
