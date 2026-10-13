import {
  AD_ACTIONS,
  AD_CAMPAIGN_STATUSES,
  type AdAction,
  type AdCampaignStatus,
} from '@marketplace-sandbox/contracts';

export type CampaignStatus = AdCampaignStatus;
export type CampaignAction = AdAction;
export const CAMPAIGN_STATUSES = AD_CAMPAIGN_STATUSES;
export const CAMPAIGN_ACTIONS = AD_ACTIONS;

/** `ACTIVE ⇄ PAUSED → ENDED` and `ACTIVE → ENDED`; ENDED is terminal (FR-005). `null` is an illegal pair. */
const TRANSITIONS: Record<
  CampaignStatus,
  Partial<Record<CampaignAction, CampaignStatus>>
> = {
  ACTIVE: { pause: 'PAUSED', end: 'ENDED' },
  PAUSED: { resume: 'ACTIVE', end: 'ENDED' },
  ENDED: {},
};

export const nextStatus = (
  from: CampaignStatus,
  action: CampaignAction,
): CampaignStatus | null => TRANSITIONS[from][action] ?? null;

/** What other capabilities read (S32): a product is sponsored exactly while its campaign is ACTIVE. */
export const isSponsored = (status: CampaignStatus): boolean =>
  status === 'ACTIVE';

/** The status reason after a transition: a pause or an end names its cause, a resume clears it. */
export const reasonAfter = (
  action: CampaignAction,
  cause: 'seller' | 'product_unavailable',
): 'seller' | 'product_unavailable' | null =>
  action === 'resume' ? null : cause;
