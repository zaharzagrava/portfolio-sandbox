import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const DEVELOPER_PLATFORM_AGGREGATE = {
  aggregateType: 'developer_platform',
  retention: 'full-history',
} as const;

/**
 * A webhook endpoint failed for three days and was switched off. For whoever tells the shop about it (this domain does
 * not know who that is). `host` only: an endpoint URL can carry a secret in its path or query.
 *
 * The spec'd type is `developer_platform.webhook_endpoint_disabled`; the S53 envelope pattern allows no `_` in the first
 * segment of a type, so the event is emitted under the name that does (gaps.md of S28, "Sibling-spec follow-ups").
 */
export const WebhookEndpointDisabled = defineEvent(
  'developerplatform.webhook_endpoint_disabled',
  'developer_platform',
  1,
  z.object({
    endpointId: z.string(),
    shopId: z.string(),
    host: z.string(),
    failingSince: z.string(),
  }),
);
