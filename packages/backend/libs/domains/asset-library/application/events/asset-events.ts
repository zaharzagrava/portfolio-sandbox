import { assetEventSchemas } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * S31 events (contracts/interfaces.md): topic `assets.events` (aggregate `assets`), key `entitlementId` for the two
 * entitlement events and `productId` for the two link events. The payload shapes are `assetEventSchemas` from
 * `packages/contracts`. Events carry changes (deltas), so the topic keeps full history.
 */
export const EntitlementGranted = defineEvent(
  'assets.entitlement_granted',
  'assets',
  1,
  assetEventSchemas['assets.entitlement_granted'],
);

export const EntitlementRevoked = defineEvent(
  'assets.entitlement_revoked',
  'assets',
  1,
  assetEventSchemas['assets.entitlement_revoked'],
);

export const DigitalProductLinked = defineEvent(
  'assets.digital_product_linked',
  'assets',
  1,
  assetEventSchemas['assets.digital_product_linked'],
);

export const DigitalProductUnlinked = defineEvent(
  'assets.digital_product_unlinked',
  'assets',
  1,
  assetEventSchemas['assets.digital_product_unlinked'],
);

export const ASSETS_AGGREGATE: TopicRegistration = {
  aggregateType: 'assets',
  retention: 'full-history',
};
