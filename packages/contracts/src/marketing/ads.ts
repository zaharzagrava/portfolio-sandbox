import { z } from 'zod';

/** S36 `GET /ads/sponsored?category&limit` (specs/domains/S36-sponsored-listings/spec.md): at most 3 items, one per shop. */
export const sponsoredSlotSchema = z.object({
  campaignId: z.string(),
  productId: z.string(),
  shopId: z.string(),
  title: z.string(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  sponsored: z.literal(true),
  clickUrl: z.string().min(1),
  expiresAt: z.string(),
});
export type SponsoredSlot = z.infer<typeof sponsoredSlotSchema>;

export const sponsoredSlotsResponseSchema = z.object({
  items: z.array(sponsoredSlotSchema).max(3),
  generatedAt: z.string(),
});
export type SponsoredSlotsResponse = z.infer<
  typeof sponsoredSlotsResponseSchema
>;

/**
 * The rest of S36 (campaigns, billing statement, click records, events). Contract:
 * specs/domains/S36-sponsored-listings/contracts/ads-api.md and events.md. Money is integer minor units in EUR.
 */

export const AD_CPC_MIN_MINOR = 1;
export const AD_CPC_MAX_MINOR = 10_000;
export const AD_BUDGET_MIN_MINOR = 100;
export const AD_BUDGET_MAX_MINOR = 10_000_000;
export const AD_CURRENCY = 'EUR' as const;
export const AD_MAX_OPEN_CAMPAIGNS_PER_SHOP = 50;
export const AD_SLOTS_MAX = 3;
export const AD_LIST_DEFAULT_LIMIT = 20;
export const AD_LIST_MAX_LIMIT = 100;
export const AD_STATEMENT_MAX_DAYS = 92;
export const AD_TOKEN_MAX_LENGTH = 2048;
export const AD_CLICK_SALTS = 10;

export const AD_PROBLEM_CODES = [
  'validation_failed',
  'invalid_cursor',
  'invalid_token',
  'permission_denied',
  'shop_not_found',
  'product_not_found',
  'campaign_not_found',
  'campaign_already_exists',
  'invalid_transition',
  'product_unavailable',
  'shop_inactive',
  'budget_below_cpc',
  'campaign_limit_reached',
  'product_not_sponsorable',
  'rate_limited',
  'rate_limiter_unavailable',
  'service_unavailable',
] as const;
export type AdProblemCode = (typeof AD_PROBLEM_CODES)[number];

export const AD_CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'ENDED'] as const;
export type AdCampaignStatus = (typeof AD_CAMPAIGN_STATUSES)[number];
export const AD_STATUS_REASONS = ['seller', 'product_unavailable'] as const;
export type AdStatusReason = (typeof AD_STATUS_REASONS)[number];
export const AD_ACTIONS = ['pause', 'resume', 'end'] as const;
export type AdAction = (typeof AD_ACTIONS)[number];

/** Field rules only: `dailyBudgetMinor >= cpcMinor` is a business rule (`422 budget_below_cpc`), not a `400`. */
export const createAdCampaignRequestSchema = z
  .object({
    productId: z.uuid(),
    cpcMinor: z.number().int().min(AD_CPC_MIN_MINOR).max(AD_CPC_MAX_MINOR),
    dailyBudgetMinor: z
      .number()
      .int()
      .min(AD_BUDGET_MIN_MINOR)
      .max(AD_BUDGET_MAX_MINOR),
  })
  .strict();
export type CreateAdCampaignRequest = z.infer<
  typeof createAdCampaignRequestSchema
>;

export const budgetBelowCpc = (
  request: Pick<CreateAdCampaignRequest, 'cpcMinor' | 'dailyBudgetMinor'>,
): boolean => request.dailyBudgetMinor < request.cpcMinor;

export const adCampaignSchema = z.object({
  id: z.uuid(),
  shopId: z.uuid(),
  productId: z.uuid(),
  category: z.string(),
  cpcMinor: z.number().int(),
  dailyBudgetMinor: z.number().int(),
  currency: z.literal(AD_CURRENCY),
  status: z.enum(AD_CAMPAIGN_STATUSES),
  statusReason: z.enum(AD_STATUS_REASONS).nullable(),
  campaignVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdCampaign = z.infer<typeof adCampaignSchema>;

export const adCampaignPageSchema = z.object({
  items: z.array(adCampaignSchema),
  nextCursor: z.string().nullable(),
});
export type AdCampaignPage = z.infer<typeof adCampaignPageSchema>;

export const adCampaignDetailSchema = adCampaignSchema.extend({
  billedTodayMinor: z.number().int(),
});
export type AdCampaignDetail = z.infer<typeof adCampaignDetailSchema>;

const listLimit = z
  .string()
  .regex(/^[0-9]{1,4}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(AD_LIST_MAX_LIMIT));

/** `GET /shops/:shopId/ads/campaigns?status&limit&cursor` */
export const adCampaignListQuerySchema = z
  .object({
    status: z.enum(AD_CAMPAIGN_STATUSES).optional(),
    limit: listLimit.default(AD_LIST_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

const instant = z.iso.datetime();

/** `GET …/billing?from&to&limit&cursor`: the range rules (`from < to`, ≤ 92 days) are checked by the service. */
export const adBillingQuerySchema = z
  .object({
    from: instant.optional(),
    to: instant.optional(),
    limit: listLimit.default(AD_LIST_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

export const adBillingAdjustmentSchema = z.object({
  sequence: z.number().int().positive(),
  deltaClicks: z.number().int(),
  deltaMinor: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
});

export const adBillingItemSchema = z.object({
  hour: z.iso.datetime(),
  state: z.enum(['PENDING', 'CHARGED']),
  source: z.enum(['stream', 'reconciliation']),
  clicks: z.number().int().nonnegative(),
  billableClicks: z.number().int().nonnegative(),
  cappedClicks: z.number().int().nonnegative(),
  amountMinor: z.number().int().nonnegative(),
  adjustments: z.array(adBillingAdjustmentSchema),
  netAmountMinor: z.number().int(),
});
export type AdBillingItem = z.infer<typeof adBillingItemSchema>;

export const adBillingPageSchema = z.object({
  items: z.array(adBillingItemSchema),
  nextCursor: z.string().nullable(),
});
export type AdBillingPage = z.infer<typeof adBillingPageSchema>;

/** `GET /ads/sponsored?category&limit`: `all` (default) or a lower-case slug; 1 to 3 slots. */
export const AD_CATEGORY_PATTERN = /^[a-z0-9-]{1,40}$/;
export const sponsoredQuerySchema = z.object({
  category: z
    .string()
    .refine((c) => c === 'all' || AD_CATEGORY_PATTERN.test(c))
    .default('all'),
  limit: z
    .string()
    .regex(/^[0-9]{1,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(AD_SLOTS_MAX))
    .default(AD_SLOTS_MAX),
});

/** ClickHouse's `DateTime64(3)` input form, UTC. */
export const AD_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
export const AD_MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/;
export const AD_INVALID_REASONS = [
  'ip_burst',
  'repeat_clicker',
  'filter_unavailable',
] as const;
export type AdInvalidReason = (typeof AD_INVALID_REASONS)[number];

/** Value of `ads.clicks` (snake_case, as the analytics store consumes it). `invalid_reason` is null iff `valid` is 1. */
export const adClickRecordSchema = z
  .object({
    click_id: z.uuid(),
    campaign_id: z.uuid(),
    shop_id: z.uuid(),
    product_id: z.uuid(),
    received_at: z.string().regex(AD_TIME_PATTERN),
    ip_hash: z.string().regex(/^[0-9a-f]{32}$/),
    viewer_hash: z.string().regex(/^[0-9a-f]{32}$/),
    valid: z.union([z.literal(0), z.literal(1)]),
    invalid_reason: z.enum(AD_INVALID_REASONS).nullable(),
  })
  .strict()
  .refine((r) => (r.valid === 1) === (r.invalid_reason === null), {
    message: 'invalid_reason is null exactly when valid is 1',
    path: ['invalid_reason'],
  });
export type AdClickRecord = z.infer<typeof adClickRecordSchema>;

/** Value of `ads.click-aggregates`: one (campaign, minute) partial of one source batch. */
export const minuteAggregateSchema = z
  .object({
    campaign_id: z.uuid(),
    minute: z.string().regex(AD_MINUTE_PATTERN),
    source_partition: z.number().int().nonnegative(),
    first_offset: z.number().int().nonnegative(),
    clicks: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  })
  .strict();
export type MinuteAggregate = z.infer<typeof minuteAggregateSchema>;

/** Payload of `marketing.campaign_created|paused|resumed|ended` v1 (topic `marketing.events`, key = campaign id). */
export const adCampaignEventPayloadSchema = z
  .object({
    campaignId: z.uuid(),
    shopId: z.uuid(),
    productId: z.uuid(),
    category: z.string(),
    cpcMinor: z.number().int(),
    dailyBudgetMinor: z.number().int(),
    status: z.enum(AD_CAMPAIGN_STATUSES),
    statusReason: z.enum(AD_STATUS_REASONS).nullable(),
    campaignVersion: z.number().int().positive(),
  })
  .strict();
export type AdCampaignEventPayload = z.infer<
  typeof adCampaignEventPayloadSchema
>;

/** Payload of `marketing.product_sponsorship_changed` v1 (key = product id), what S32 consumes. */
export const productSponsorshipChangedPayloadSchema = z
  .object({
    productId: z.uuid(),
    shopId: z.uuid(),
    sponsored: z.boolean(),
    sponsorshipVersion: z.number().int().positive(),
  })
  .strict();
export type ProductSponsorshipChangedPayload = z.infer<
  typeof productSponsorshipChangedPayloadSchema
>;
