import { Channel, NotificationType, Priority } from './catalog';

/** Catalogue types plus the one-off transactional mails sent directly (no preferences, no queue). */
export type DeliveryType = NotificationType | 'auth.password_reset';

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
  type: DeliveryType;
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
  /** ISO instant after which the notice is moot; the worker re-checks it at send time (FR-024, FR-033). */
  staleAt?: string;
  /** ISO instant the router handed the delivery to its line: the start of `notifications_delivery_latency_seconds`. */
  routedAt?: string;
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

// ---- S28 routing model (data-model.md "Entities"). The older `NotificationRequest` / `Recipient` above are retired
// when the router moves to these (US1). ---------------------------------------------------------------------------

/** Who a request is for: a user, or (invitations) a bare address. Shop owners and followers are expanded before this. */
export type RequestRecipient =
  { kind: 'user'; userId: string } | { kind: 'address'; email: string };

/** "Tell this recipient about this fact": the output of the event mapping. Dedupe identity = sourceId|recipientKey|channel. */
export interface RoutingRequest {
  type: NotificationType;
  recipient: RequestRecipient;
  /** Template variables (already formatted strings). Holds a secret only for address recipients (invite token). */
  data: Record<string, string>;
  /** Source event id, or the owner's own dedupe key (chat). */
  sourceId: string;
  occurredAt: string;
  /** Monotonic version of the aggregate (`orderVersion`, ...), when the event has one. */
  sourceVersion?: number;
  /** Version-guard family and aggregate: `ver:<family>:<aggregateId>`. */
  family?: string;
  aggregateId?: string;
}

export interface DeviceView {
  id: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
}

/** What routing needs to know about a user, read once per batch (`rv:<userId>` cache, 5 minutes, invalidated on write). */
export interface RecipientView {
  userId: string;
  email: string | null;
  phone: string | null;
  phoneVerified: boolean;
  locale: string;
  timezone: string;
  quietStart: string | null;
  quietEnd: string | null;
  /** `${category}:${channel}` -> explicit choice. */
  overrides: Record<string, boolean>;
  devices: DeviceView[];
}

export type SuppressionReason =
  | 'bounce'
  | 'hard-bounce'
  | 'complaint'
  | 'stop'
  | 'sms-stop'
  | 'invalid_token'
  | 'manual'
  | 'provider-permanent';

export type DeliveryLine = 'transactional' | 'marketing';

/** Delivery timeline statuses; precedence in `delivery-status.ts` (US6). */
export const DELIVERY_STATUSES = [
  'queued',
  'delayed',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'suppressed',
  'capped',
  'skipped',
  'expired',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Why a message went to a dead-letter queue. Never carries the body. */
export type DeadLetterReason =
  | 'invalid_payload'
  | 'unsupported_version'
  | 'render_failed'
  | 'malformed_message'
  | 'invalid_message'
  | 'exhausted';
