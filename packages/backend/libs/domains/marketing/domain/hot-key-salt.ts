import { AD_CLICK_SALTS } from '@marketplace-sandbox/contracts';
import { murmur3 } from '@app/common/core/murmur3';

export const HOT_KEY_SALTS = AD_CLICK_SALTS;

/**
 * FR-030: a viral campaign must not funnel its clicks into one partition, so the Kafka key gets a salt 0-9. The salt is
 * a deterministic function of the click id (never `Math.random`): a retried click lands on the same partition and a
 * replay is reproducible.
 */
export const hotKeySalt = (clickId: string): number =>
  murmur3(clickId) % HOT_KEY_SALTS;

/** `ads.clicks` key: `<campaignId>#<0-9>`. */
export const clickKey = (campaignId: string, clickId: string): string =>
  `${campaignId}#${hotKeySalt(clickId)}`;
