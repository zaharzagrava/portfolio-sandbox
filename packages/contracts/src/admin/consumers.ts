import { z } from 'zod';

/** Consumer groups the journey may pause, resume and replay (S53). */
export const JOURNEY_CONSUMER_GROUPS = [
  'payments-order-copy',
  'orders-payment-results',
  'ledger-settlement',
  'ledger-balances',
  'notification-router',
  'statements-facts',
  // J02 (seller to first sale), canonical names of its contract
  'identity-seller-promotion',
  'tenancy-shop-lifecycle',
  'entitlements-invalidation',
  'search-product-index',
  'webhook-router',
  'leaderboards',
  'product-cache-invalidator',
  'document-extractor',
] as const;

export const consumerStateSchema = z.enum(['RUNNING', 'PAUSED']);

export const consumerViewSchema = z.object({
  group: z.string().min(1),
  topics: z.array(z.string()),
  state: consumerStateSchema,
  lag: z.number().int().min(0),
  lastProcessedAt: z.iso.datetime().nullable(),
  dlqDepth: z.number().int().min(0),
});

export const consumerReplaySchema = z.object({ since: z.iso.datetime() });
export const consumerRedriveSchema = z.object({ limit: z.number().int().min(1).max(1000).optional() });
export const consumerRedriveResultSchema = z.object({ requeued: z.number().int().min(0) });

export type ConsumerView = z.infer<typeof consumerViewSchema>;
export type ConsumerReplay = z.infer<typeof consumerReplaySchema>;
