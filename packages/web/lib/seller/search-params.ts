/**
 * Typed readers for the URL state of the seller pages (W04 FR-004, P0901). Each takes a Next `searchParams` object and
 * returns the default for a missing or invalid value, never an error. `buildQuery` is the matching writer: defaults and
 * empty values are left out of the address.
 */
export type RawSearchParams = Record<string, string | string[] | undefined>;

const one = (raw: string | string[] | undefined): string | undefined => (typeof raw === 'string' ? raw : undefined);
const pick = <T extends string>(raw: string | string[] | undefined, allowed: readonly T[], fallback: T): T => {
  const value = one(raw);
  return allowed.includes(value as T) ? (value as T) : fallback;
};
const bool = (raw: string | string[] | undefined): boolean | undefined => {
  const value = one(raw);
  return value === 'true' ? true : value === 'false' ? false : undefined;
};
const uuid = (raw: string | string[] | undefined): string | undefined => {
  const value = one(raw);
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
};
const text = (raw: string | string[] | undefined, max: number): string => (one(raw) ?? '').slice(0, max);
const day = (raw: string | string[] | undefined): string | undefined => {
  const value = one(raw);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : value;
};

/** Cursors are opaque, URL-safe and short; anything else is dropped (the list then starts at its first page). */
export function readCursor(raw: string | string[] | undefined): string | undefined {
  const value = one(raw);
  return value && value.length <= 512 && /^[A-Za-z0-9_\-=.~]+$/.test(value) ? value : undefined;
}

export const OVERVIEW_DAYS = [7, 30, 90] as const;
export type OverviewDays = (typeof OVERVIEW_DAYS)[number];
export const DEFAULT_OVERVIEW_DAYS: OverviewDays = 30;

/** `?days=` of the overview: 7, 30 (default) or 90. */
export function readDays(raw: string | string[] | undefined): OverviewDays {
  const value = one(raw);
  const days = value && /^\d+$/.test(value) ? Number(value) : NaN;
  return (OVERVIEW_DAYS as readonly number[]).includes(days) ? (days as OverviewDays) : DEFAULT_OVERVIEW_DAYS;
}

export type InventoryParams = { q: string; status: 'ACTIVE' | 'ARCHIVED'; inStock: boolean | undefined; cursor: string | undefined };
export function readInventoryParams(raw: RawSearchParams): InventoryParams {
  return {
    q: text(raw.q, 200),
    status: pick(raw.status, ['ACTIVE', 'ARCHIVED'], 'ACTIVE'),
    inStock: bool(raw.inStock),
    cursor: readCursor(raw.cursor),
  };
}

export type OrdersParams = { status: string | undefined; cursor: string | undefined };
export function readOrdersParams(raw: RawSearchParams): OrdersParams {
  const status = one(raw.status);
  return { status: status && /^[A-Z_]{1,32}$/.test(status) ? status : undefined, cursor: readCursor(raw.cursor) };
}

export const TEAM_TABS = ['members', 'invitations', 'roles'] as const;
export const INVITE_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type TeamParams = { tab: (typeof TEAM_TABS)[number]; status: (typeof INVITE_STATUSES)[number]; cursor: string | undefined };
export function readTeamParams(raw: RawSearchParams): TeamParams {
  return { tab: pick(raw.tab, TEAM_TABS, 'members'), status: pick(raw.status, INVITE_STATUSES, 'pending'), cursor: readCursor(raw.cursor) };
}

export const USAGE_DAYS = [7, 14, 30] as const;
export type UsageParams = { days: (typeof USAGE_DAYS)[number]; livemode: boolean };
export function readUsageParams(raw: RawSearchParams): UsageParams {
  const value = one(raw.days);
  const days = value && /^\d+$/.test(value) ? Number(value) : NaN;
  return {
    days: (USAGE_DAYS as readonly number[]).includes(days) ? (days as UsageParams['days']) : 30,
    livemode: bool(raw.livemode) ?? true,
  };
}

/** An event id of the delivery log: `evt_` and 32 hex characters (S43), or a UUID. */
const eventId = (raw: string | string[] | undefined): string | undefined => {
  const value = one(raw);
  return value && /^evt_[0-9a-f]{32}$/i.test(value) ? value : uuid(raw);
};

export type WebhookAttemptsParams ={ ok: boolean | undefined; event: string | undefined; cursor: string | undefined };
export function readWebhookAttemptsParams(raw: RawSearchParams): WebhookAttemptsParams {
  return { ok: bool(raw.ok), event: eventId(raw.event), cursor: readCursor(raw.cursor) };
}

export const LOG_STATUSES = ['any', '2xx', '4xx', '5xx', '429'] as const;
export type LogsParams = {
  requestId: string;
  status: (typeof LOG_STATUSES)[number];
  route: string;
  keyId: string | undefined;
  livemode: boolean | undefined;
  from: string | undefined;
  to: string | undefined;
  cursor: string | undefined;
};
export function readLogsParams(raw: RawSearchParams): LogsParams {
  return {
    requestId: text(raw.requestId, 128),
    status: pick(raw.status, LOG_STATUSES, 'any'),
    route: text(raw.route, 200),
    keyId: uuid(raw.keyId),
    livemode: bool(raw.livemode),
    from: day(raw.from),
    to: day(raw.to),
    cursor: readCursor(raw.cursor),
  };
}

/** The query string (no leading `?`) for the values that differ from their defaults, in the order given. */
export function buildQuery(values: Record<string, string | number | boolean | undefined>, defaults: Record<string, string | number | boolean | undefined> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '' || value === defaults[key]) continue;
    query.set(key, String(value));
  }
  return query.toString();
}
