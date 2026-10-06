import { Channel, NotificationType, Priority } from './catalog';

/** What domain code asks for: "tell user X about Y". */
export interface NotificationRequest {
  type: NotificationType;
  userId: string;
  /** Template variables (already formatted strings). */
  data: Record<string, string>;
  /** Stable per logical notification (usually the source eventId) - replays reuse every derived id. */
  dedupeKey: string;
  occurredAt?: string;
}

/** One message on a channel queue: fully rendered, so channel workers stay dumb and fast. */
export interface DeliveryMessage {
  deliveryId: string;
  userId: string;
  type: NotificationType;
  channel: Exclude<Channel, 'inapp'>;
  priority: Priority;
  /** email address / E.164 phone / push tokens */
  to: string[];
  subject: string;
  html: string;
  title: string;
  body: string;
  link: string;
  unsubscribeUrl?: string;
}

export interface Recipient {
  userId: string;
  email: string | null;
  phone: string | null;
  locale: string;
  timezone: string;
  quietStart: string | null;
  quietEnd: string | null;
  pushTokens: string[];
  /** `${category}:${channel}` → explicit choice */
  overrides: Record<string, boolean>;
}

export const NOTIFICATION_QUEUES = {
  email: 'notifications-email',
  sms: 'notifications-sms',
  push: 'notifications-push',
  marketing: 'notifications-marketing',
} as const;

export class PermanentDeliveryError extends Error {
  constructor(
    message: string,
    /** Addresses to add to the suppression list (invalid number, unregistered push token...). */
    readonly suppress: string[] = [],
  ) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}
