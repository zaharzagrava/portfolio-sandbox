import { NOTIFICATION_CATEGORIES, notificationPreferencesSchema, type NotificationChannel, type NotificationPreferences } from '@marketplace-sandbox/contracts';

/**
 * S28 test fixtures for MSW: the preferences matrix as `GET /api/notifications/preferences` answers it (defaults of AS-14),
 * parsed with the contract schema when built so a fixture that drifts from the wire shape fails loudly.
 */
export function preferencesBody(
  settings: Partial<NotificationPreferences['settings']> = {},
  cell?: { category: string; channel: NotificationChannel; enabled: boolean },
): NotificationPreferences {
  return notificationPreferencesSchema.parse({
    settings: { timezone: 'UTC', locale: 'en', quietStart: null, quietEnd: null, phone: null, phoneVerified: false, ...settings },
    preferences: NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      channels: {
        email: category !== 'marketing',
        sms: false,
        push: category !== 'marketing',
        inapp: true,
        ...(cell?.category === category ? { [cell.channel]: cell.enabled } : {}),
      },
      mandatoryChannels: category === 'security' ? ['email'] : [],
    })),
  });
}
