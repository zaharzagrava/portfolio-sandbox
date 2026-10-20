import { z } from "zod";

/**
 * S37 short links (specs/domains/S37-share-links/contracts/share-links-api.md). Used by the controllers, the e2e specs
 * and the edge worker's parity test (FR-105). No owner and no store key ever appears in a response.
 */

export const SHORT_LINK_DESTINATION_MAX = 2048;
export const SHORT_LINK_ALIAS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SHORT_LINK_ALIAS_MIN = 4;
export const SHORT_LINK_ALIAS_MAX = 32;
export const SHORT_LINK_TTL_DAYS_MAX = 3650;

/** Generated codes are 7 base-62 characters; custom aliases follow the alias rule above. */
export const SHORT_LINK_GENERATED_CODE_PATTERN = /^[0-9A-Za-z]{7}$/;

export const SHORT_LINK_PROBLEM_CODES = [
  "validation_failed",
  "invalid_cursor",
  "alias_taken",
  "alias_reserved",
  "destination_not_allowed",
  "destination_blocked",
  "destination_check_unavailable",
  "link_limit_reached",
  "link_not_found",
  "link_gone",
  "link_not_active",
  "code_generation_failed",
  "service_unavailable",
] as const;
export type ShortLinkProblemCode = (typeof SHORT_LINK_PROBLEM_CODES)[number];

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters and whitespace
const NO_WHITESPACE_OR_CONTROL = /^[^\s\u0000-\u001f\u007f]*$/;

const destinationField = z
  .string()
  .min(1)
  .max(SHORT_LINK_DESTINATION_MAX)
  .regex(NO_WHITESPACE_OR_CONTROL);

export const createShortLinkRequestSchema = z
  .object({
    destination: destinationField,
    alias: z
      .string()
      .min(SHORT_LINK_ALIAS_MIN)
      .max(SHORT_LINK_ALIAS_MAX)
      .regex(SHORT_LINK_ALIAS_PATTERN)
      .optional(),
    ttlDays: z.number().int().min(1).max(SHORT_LINK_TTL_DAYS_MAX).optional(),
  })
  .strict();
export type CreateShortLinkRequest = z.infer<
  typeof createShortLinkRequestSchema
>;

/** Destination only; any other property is unknown and refused. */
export const updateShortLinkRequestSchema = z
  .object({ destination: destinationField })
  .strict();
export type UpdateShortLinkRequest = z.infer<
  typeof updateShortLinkRequestSchema
>;

/** Exactly the fields S37 publishes; no owner or internal key. */
export const shortLinkSchema = z
  .object({
    code: z.string().min(1),
    shortUrl: z.url(),
    destination: z.string().min(1),
    status: z.enum(["ACTIVE", "DISABLED"]),
    kind: z.enum(["generated", "custom"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    expiresAt: z.string().nullable(),
    disabledAt: z.string().optional(),
  })
  .strict();
export type ShortLink = z.infer<typeof shortLinkSchema>;

export const shortLinkPageSchema = z
  .object({
    items: z.array(shortLinkSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ShortLinkPage = z.infer<typeof shortLinkPageSchema>;

export const LINK_STATS_RANGES = ["24h", "7d", "30d"] as const;
export type LinkStatsRange = (typeof LINK_STATS_RANGES)[number];

export const linkStatsSchema = z
  .object({
    code: z.string(),
    range: z.enum(LINK_STATS_RANGES),
    from: z.string(),
    to: z.string(),
    bucket: z.enum(["minute", "hour", "day"]),
    total: z.number().int().min(0),
    /** J05: confirmed conversions of the link and their value net of refunds (minor units). */
    conversions: z.number().int().min(0),
    convertedMinor: z.number().int().min(0),
    series: z.array(
      z.object({ start: z.string(), clicks: z.number().int().min(0) }),
    ),
    countries: z
      .array(z.object({ country: z.string(), clicks: z.number().int().min(0) }))
      .max(10),
  })
  .strict();
export type LinkStats = z.infer<typeof linkStatsSchema>;

/** Payload of `link.clicked` v1 (topic `links.events`, key = code); see contracts/events.md. */
export const linkClickedEventSchema = z
  .object({
    clickId: z.uuid(),
    code: z.string().min(1).max(32),
    ts: z.iso.datetime({ offset: false }),
    country: z.string().regex(/^(?:[A-Z]{2})?$/),
    referer: z.string().max(300),
    viaEdge: z.boolean(),
  })
  .strict();
export type LinkClickedPayload = z.infer<typeof linkClickedEventSchema>;

/** One credited purchase of a link (J05). No buyer, no order id: the conversion has its own id. */
export const linkConversionSchema = z
  .object({
    conversionId: z.uuid(),
    paidAt: z.string(),
    amountMinor: z.number().int().min(0),
    currency: z.string(),
    status: z.enum(["CONFIRMED", "REVERSED"]),
    refundedMinor: z.number().int().min(0),
  })
  .strict();
export type LinkConversion = z.infer<typeof linkConversionSchema>;

export const linkConversionPageSchema = z
  .object({
    items: z.array(linkConversionSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type LinkConversionPage = z.infer<typeof linkConversionPageSchema>;

/** Payload of `link.converted` v1 (topic `links.events`, key = code). */
export const linkConvertedEventSchema = z
  .object({
    conversionId: z.uuid(),
    linkCode: z.string().min(1),
    amountMinor: z.number().int().min(0),
    currency: z.string(),
    paidAt: z.string(),
  })
  .strict();
export type LinkConvertedPayload = z.infer<typeof linkConvertedEventSchema>;

/** Payload of `link.conversion_reversed` v1 (topic `links.events`, key = code). */
export const linkConversionReversedEventSchema = z
  .object({
    conversionId: z.uuid(),
    linkCode: z.string().min(1),
    refundedMinor: z.number().int().min(0),
    amountMinor: z.number().int().min(0),
  })
  .strict();
export type LinkConversionReversedPayload = z.infer<
  typeof linkConversionReversedEventSchema
>;
