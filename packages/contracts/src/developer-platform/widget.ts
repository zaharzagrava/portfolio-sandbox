import { z } from 'zod';

/**
 * S44 contracts (specs/domains/S44-storefront-widget/contracts): the dashboard API of widget sites, the public widget API,
 * the `developerplatform.widget_site_changed` event and the closed list of problem codes. Nothing here carries the
 * sealed secret columns; the identity secret appears only in the create and rotate answers.
 */
export const WIDGET_LIMITS = {
  sitesPerShop: 10,
  originsPerSite: 10,
  featuredProducts: 12,
  name: { min: 1, max: 60, default: 'Storefront widget' },
  overlapHours: { min: 0, max: 72, default: 24 },
  handoffMaxLifetimeSec: 300,
  widgetTokenLifetimeSec: 900,
  bodyMaxBytes: 8 * 1024,
  tokenMaxBytes: 4 * 1024,
  pageLimit: { min: 1, max: 100, default: 20 },
} as const;

export const WIDGET_PUBLISHABLE_KEY = /^pk_live_[A-Za-z0-9_-]{24}$/;
export const WIDGET_IDENTITY_SECRET = /^wis_[A-Za-z0-9_-]{43}$/;

export const WIDGET_ERROR_CODES = [
  'validation_failed',
  'origin_invalid',
  'origin_not_allowed',
  'widget_site_not_found',
  'widget_disabled',
  'identity_token_invalid',
  'widget_token_invalid',
  'site_limit_reached',
  'site_version_conflict',
  'featured_product_invalid',
  'rotation_in_progress',
  'rotation_not_in_progress',
  'invalid_cursor',
  'unsupported_media_type',
  'payload_too_large',
  'rate_limited',
  'rate_limiter_unavailable',
  'service_unavailable',
  'shop_not_found',
  'shop_suspended',
  'shop_offboarding',
  'permission_denied',
  'csrf_invalid',
  'unauthorized',
  'not_found',
  'internal_error',
] as const;
export const widgetErrorCodeSchema = z.enum(WIDGET_ERROR_CODES);
export type WidgetErrorCode = z.infer<typeof widgetErrorCodeSchema>;

/** Problem document of every widget error (RFC 9457 + `code` and `requestId`). */
export const widgetProblemSchema = z.looseObject({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string(),
  requestId: z.string().min(1),
  code: z.string(),
});
export type WidgetProblem = z.infer<typeof widgetProblemSchema>;

export const ORIGIN_REJECTION_REASONS = [
  'not_https',
  'not_an_origin',
  'userinfo',
  'wildcard',
  'ip_literal',
  'localhost',
  'single_label_host',
  'trailing_dot',
  'malformed',
  'bad_port',
] as const;
export type OriginRejection = (typeof ORIGIN_REJECTION_REASONS)[number];

// ---------------------------------------------------------------- theme

export const THEME_FONT_FAMILIES = ['system', 'serif', 'mono'] as const;
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** AS-04: only these keys, only these value formats. The loader re-checks the same rules. */
export const widgetThemeSchema = z
  .object({
    primaryColor: colour.optional(),
    textColor: colour.optional(),
    backgroundColor: colour.optional(),
    borderRadius: z
      .string()
      .regex(/^(?:[0-9]|1[0-9]|2[0-4])px$/)
      .optional(),
    fontFamily: z.enum(THEME_FONT_FAMILIES).optional(),
    buttonLabel: z
      .string()
      .min(1)
      .max(40)
      // eslint-disable-next-line no-control-regex -- control characters are exactly what the label must not contain
      .regex(/^[^<>\u0000-\u001f\u007f]+$/)
      .optional(),
  })
  .strict();
export type WidgetTheme = z.infer<typeof widgetThemeSchema>;

// ---------------------------------------------------------------- dashboard

const instant = z.iso.datetime({ offset: true });
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const siteName = z
  .string()
  .min(WIDGET_LIMITS.name.min)
  .max(WIDGET_LIMITS.name.max);
const origins = z.array(z.string()).min(1).max(WIDGET_LIMITS.originsPerSite);
const featured = z.array(uuid).max(WIDGET_LIMITS.featuredProducts);

export const createWidgetSiteRequestSchema = z
  .object({
    name: siteName.optional(),
    origins,
    featuredProductIds: featured.optional(),
  })
  .strict();
export type CreateWidgetSiteRequest = z.infer<
  typeof createWidgetSiteRequestSchema
>;

export const updateWidgetSiteRequestSchema = z
  .object({
    name: siteName.optional(),
    allowedOrigins: origins.optional(),
    featuredProductIds: featured.optional(),
    theme: widgetThemeSchema.optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type UpdateWidgetSiteRequest = z.infer<
  typeof updateWidgetSiteRequestSchema
>;

export const rotateWidgetSecretRequestSchema = z
  .object({
    overlapHours: z
      .number()
      .int()
      .min(WIDGET_LIMITS.overlapHours.min)
      .max(WIDGET_LIMITS.overlapHours.max)
      .optional(),
  })
  .strict();
export type RotateWidgetSecretRequest = z.infer<
  typeof rotateWidgetSecretRequestSchema
>;

export const widgetKillSwitchRequestSchema = z
  .object({ on: z.boolean() })
  .strict();

export const widgetSiteSchema = z.object({
  id: uuid,
  shopId: uuid,
  name: z.string(),
  publishableKey: z.string().regex(WIDGET_PUBLISHABLE_KEY),
  allowedOrigins: z.array(z.string()),
  featuredProductIds: z.array(uuid),
  theme: widgetThemeSchema,
  killSwitch: z.boolean(),
  hasPreviousSecret: z.boolean(),
  previousSecretExpiresAt: instant.nullable(),
  version: z.number().int(),
  createdAt: instant,
  updatedAt: instant,
});
export type WidgetSiteDto = z.infer<typeof widgetSiteSchema>;

export const widgetSiteCreatedSchema = widgetSiteSchema.extend({
  identitySecret: z.string().regex(WIDGET_IDENTITY_SECRET),
});
export type WidgetSiteCreatedDto = z.infer<typeof widgetSiteCreatedSchema>;

export const widgetSecretRotatedSchema = z.object({
  identitySecret: z.string().regex(WIDGET_IDENTITY_SECRET),
  previousSecretExpiresAt: instant.nullable(),
});

export const widgetSitePageSchema = z.object({
  items: z.array(widgetSiteSchema),
  nextCursor: z.string().nullable(),
});

export const widgetSiteHistoryItemSchema = z.object({
  id: uuid,
  change: z.enum(['kill_switch_on', 'kill_switch_off']),
  from: z.string().nullable(),
  to: z.string().nullable(),
  actorId: uuid.nullable(),
  at: instant,
});
export const widgetSiteHistoryPageSchema = z.object({
  items: z.array(widgetSiteHistoryItemSchema),
  nextCursor: z.string().nullable(),
});

// ---------------------------------------------------------------- public widget API

export const widgetConfigSchema = z.object({
  version: z.literal('v1'),
  shop: z.object({ name: z.string() }),
  theme: widgetThemeSchema,
  products: z
    .array(
      z.object({
        id: uuid,
        title: z.string(),
        price: z.object({
          amountMinor: z.number().int(),
          currency: z.string(),
        }),
        inStock: z.boolean(),
      }),
    )
    .max(WIDGET_LIMITS.featuredProducts),
  checkoutUrl: z.string(),
});
export type WidgetConfigDto = z.infer<typeof widgetConfigSchema>;

export const widgetIdentifyRequestSchema = z
  .object({
    key: z.string(),
    token: z.string().min(1).max(WIDGET_LIMITS.tokenMaxBytes),
  })
  .strict();

export const widgetIdentifySchema = z.object({
  widgetToken: z.string().min(1),
  expiresIn: z.literal(WIDGET_LIMITS.widgetTokenLifetimeSec),
  customer: z.object({ id: z.string(), email: z.string().nullable() }),
});
export type WidgetIdentifyDto = z.infer<typeof widgetIdentifySchema>;

export const widgetSessionSchema = z.object({
  site: z.object({ id: uuid }),
  customer: z.object({ id: z.string(), email: z.string().nullable() }),
  expiresAt: instant,
});
export type WidgetSessionDto = z.infer<typeof widgetSessionSchema>;

// ---------------------------------------------------------------- event

export const WIDGET_SITE_CHANGES = [
  'created',
  'origins_changed',
  'products_changed',
  'theme_changed',
  'secret_rotated',
  'previous_secret_expired',
  'kill_switch_on',
  'kill_switch_off',
  'deleted',
] as const;
export type WidgetSiteChange = (typeof WIDGET_SITE_CHANGES)[number];

/** `developerplatform.widget_site_changed` v1: never a secret, a key or an origin list. */
export const widgetSiteChangedPayloadSchema = z.object({
  siteId: z.string(),
  shopId: z.string(),
  change: z.enum(WIDGET_SITE_CHANGES),
  actorId: z.string().optional(),
});
export type WidgetSiteChangedPayload = z.infer<
  typeof widgetSiteChangedPayloadSchema
>;
