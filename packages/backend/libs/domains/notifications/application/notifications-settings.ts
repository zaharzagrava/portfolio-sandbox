import { ApiConfigService } from '@app/common/config';

/**
 * Typed reads of the notification settings (S54 schema in `libs/common/config/notifications-config.ts`, which fails
 * startup in production for a missing or shared `notification_secret` or a missing provider credential).
 */
export interface NotificationsSettings {
  /** HMAC key of the unsubscribe token and the inbox cursor. Dedicated: there is no fallback to the JWT secret. */
  secret: string;
  /** Public base of the web app (links in mail), no trailing slash. */
  frontBase: string;
  backendBase: string;
  txConcurrency: number;
  marketingConcurrency: number;
}

const stripSlash = (url: string) => url.replace(/\/+$/, '');

export function readNotificationsSettings(
  config: ApiConfigService,
): NotificationsSettings {
  const secret = config.get('notification_secret');
  if (!secret)
    throw new Error(
      'notification_secret is not set; notifications sign tokens and cursors with it only',
    );
  return {
    secret,
    frontBase: stripSlash(config.get('front_host')),
    backendBase: stripSlash(config.get('backend_host')),
    txConcurrency: config.get('notifications_tx_concurrency'),
    marketingConcurrency: config.get('notifications_marketing_concurrency'),
  };
}
