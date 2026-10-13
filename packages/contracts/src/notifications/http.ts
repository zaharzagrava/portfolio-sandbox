import { z } from "zod";

/**
 * `/api/notifications/*` bodies and answers (specs/domains/S28-notifications/contracts/http.md). Format rules only:
 * the rules that need stored state (quiet hours set as a pair and not equal, SMS needs a verified phone) are answered
 * by the service as `422 quiet_hours_incomplete | quiet_hours_invalid | phone_not_verified`.
 */

export const NOTIFICATION_CATEGORIES = [
  "account",
  "security",
  "shop",
  "orders",
  "auctions",
  "billing",
  "payouts",
  "bookings",
  "chat",
  "discussions",
  "developers",
  "insights",
  "marketing",
] as const;
export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export const NOTIFICATION_CHANNELS = ["email", "sms", "push", "inapp"] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/** uuid-shaped (any version): inbox ids are derived from the delivery identity, not random. */
const uuidShaped = z.guid();

// ---- inbox -----------------------------------------------------------------------------------------------------

export const NOTIFICATION_TITLE_MAX = 120;
export const NOTIFICATION_BODY_MAX = 500;
export const UNREAD_COUNT_BOUND = 1000;

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
export type ListNotificationsQuery = z.infer<
  typeof listNotificationsQuerySchema
>;

export const notificationItemSchema = z.object({
  id: uuidShaped,
  type: z.string(),
  category: z.string(),
  title: z.string().max(NOTIFICATION_TITLE_MAX),
  body: z.string().max(NOTIFICATION_BODY_MAX),
  link: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationItemSchema),
  nextCursor: z.string().nullable(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const unreadCountSchema = z.object({
  unread: z.number().int().min(0).max(UNREAD_COUNT_BOUND),
});
export type UnreadCount = z.infer<typeof unreadCountSchema>;

/** Exactly one of `ids` (1..100) or `all: true`; both keys, neither, or extra keys fail. */
export const markReadRequestSchema = z.union([
  z.object({ ids: z.array(uuidShaped).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

// ---- preferences and settings ------------------------------------------------------------------------------------

export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** `xx` or `xx-YY`; the router falls back exact -> language -> English for locales without templates. */
export const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

let zones: Set<string> | undefined;
/**
 * IANA names the runtime knows: the canonical list (`Intl.supportedValuesOf('timeZone')`) plus `UTC`, plus the
 * `Area/City` names the runtime resolves although it lists them under an older name (`Europe/Kyiv` is listed as
 * `Europe/Kiev` by runtimes with an older tz database).
 */
export function isIanaTimeZone(name: string): boolean {
  zones ??= new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  if (zones.has(name)) return true;
  if (!/^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export const notificationSettingsSchema = z.object({
  timezone: z.string(),
  locale: z.string(),
  quietStart: z.string().nullable(),
  quietEnd: z.string().nullable(),
  /** Masked (`+38******67`), never the number itself. */
  phone: z.string().nullable(),
  phoneVerified: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const preferenceRowSchema = z.object({
  category: notificationCategorySchema,
  channels: z.object({
    email: z.boolean(),
    sms: z.boolean(),
    push: z.boolean(),
    inapp: z.boolean(),
  }),
  /** Channels that stay on for the mandatory types of the category, whatever the cell says. */
  mandatoryChannels: z.array(notificationChannelSchema),
});
export type PreferenceRow = z.infer<typeof preferenceRowSchema>;

export const notificationPreferencesSchema = z.object({
  settings: notificationSettingsSchema,
  preferences: z.array(preferenceRowSchema),
});
export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>;

/** An extra key is a `400`, like the settings body. */
export const updatePreferenceRequestSchema = z
  .object({
    category: notificationCategorySchema,
    channel: notificationChannelSchema,
    enabled: z.boolean(),
  })
  .strict();
export type UpdatePreferenceRequest = z.infer<
  typeof updatePreferenceRequestSchema
>;

export const updateSettingsRequestSchema = z
  .object({
    timezone: z
      .string()
      .refine(isIanaTimeZone, "unknown IANA time zone")
      .optional(),
    locale: z.string().regex(LOCALE_PATTERN).optional(),
    /** `null` clears. */
    quietStart: z.string().regex(HHMM_PATTERN).nullable().optional(),
    quietEnd: z.string().regex(HHMM_PATTERN).nullable().optional(),
    phone: z.string().regex(E164_PATTERN).nullable().optional(),
  })
  .strict();
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

export const phoneVerifyRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});
export type PhoneVerifyRequest = z.infer<typeof phoneVerifyRequestSchema>;

// ---- devices -----------------------------------------------------------------------------------------------------

export const PUSH_PLATFORMS = ["ios", "android", "web"] as const;
export const pushPlatformSchema = z.enum(PUSH_PLATFORMS);

/** Never carries the token. */
export const deviceSchema = z.object({
  id: z.string().uuid(),
  platform: pushPlatformSchema,
  lastSeenAt: z.string(),
});
export type Device = z.infer<typeof deviceSchema>;

export const deviceListSchema = z.object({ items: z.array(deviceSchema) });
export type DeviceList = z.infer<typeof deviceListSchema>;

export const registerDeviceRequestSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: pushPlatformSchema,
});
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

export const deviceIdParamSchema = z.object({ deviceId: z.string().uuid() });

// ---- unsubscribe -------------------------------------------------------------------------------------------------

export const unsubscribeQuerySchema = z.object({
  token: z.string().min(1).max(512),
});
export type UnsubscribeQuery = z.infer<typeof unsubscribeQuerySchema>;

export const unsubscribeDescribeSchema = z.object({ category: z.string() });
export const unsubscribeResultSchema = z.object({ unsubscribed: z.string() });
