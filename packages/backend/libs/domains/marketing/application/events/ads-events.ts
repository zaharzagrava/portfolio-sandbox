import {
  adCampaignEventPayloadSchema,
  productSponsorshipChangedPayloadSchema,
  type AdAction,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `marketing.events` (S36 contracts/events.md). The aggregate type `marketing` owns the topic; campaign events are keyed
 * by campaign id (`aggregateVersion = campaignVersion`), the sponsorship signal by product id
 * (`aggregateVersion = sponsorshipVersion`). Each carries the full state after the change, so a consumer's version guard
 * can ignore a stale one. The log is kept in full (no compaction: the two key spaces share one topic).
 */
export const MARKETING_AGGREGATE: TopicRegistration = {
  aggregateType: 'marketing',
  retention: 'full-history',
};

export const CampaignCreated = defineEvent(
  'marketing.campaign_created',
  'marketing',
  1,
  adCampaignEventPayloadSchema,
  { carries: 'state' },
);
export const CampaignPaused = defineEvent(
  'marketing.campaign_paused',
  'marketing',
  1,
  adCampaignEventPayloadSchema,
  { carries: 'state' },
);
export const CampaignResumed = defineEvent(
  'marketing.campaign_resumed',
  'marketing',
  1,
  adCampaignEventPayloadSchema,
  { carries: 'state' },
);
export const CampaignEnded = defineEvent(
  'marketing.campaign_ended',
  'marketing',
  1,
  adCampaignEventPayloadSchema,
  { carries: 'state' },
);

/** What S32 consumes: published only when the sponsored value of a product changes. */
export const ProductSponsorshipChanged = defineEvent(
  'marketing.product_sponsorship_changed',
  'marketing',
  1,
  productSponsorshipChangedPayloadSchema,
  { carries: 'state' },
);

export const CAMPAIGN_EVENT_FOR_ACTION = {
  pause: CampaignPaused,
  resume: CampaignResumed,
  end: CampaignEnded,
} as const satisfies Record<AdAction, unknown>;
