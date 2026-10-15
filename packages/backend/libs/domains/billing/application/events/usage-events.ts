import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * `usage.recorded` v1 (specs/domains/S18-usage-entitlements/contracts/events.md): one metered report from the public
 * API (S42), `aggregateId` = the subject (a shop or a user), the envelope `eventId` the identity that makes retries
 * harmless. Produced by developer-platform, consumed by billing's `UsageRecordedConsumer`, which validates the values
 * itself (metric allowlist, quantity 1 to 1,000,000,000, `ts` window) so every rejection has a counted reason.
 */
export const UsageRecorded = defineEvent(
  'usage.recorded',
  'usage',
  1,
  z.object({
    metric: z.string(),
    quantity: z.number().int().positive(),
    ts: z.string(),
  }),
);
