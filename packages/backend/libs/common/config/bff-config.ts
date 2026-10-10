import { createHash } from 'node:crypto';
import * as joi from 'joi';

/**
 * Settings of the BFF composition (S48 FR-051). The raw keys are optional here because every app shares one
 * `ApiConfigService`; `parseBffSettings` runs when the BFF module is built and stops the process with every
 * violation, naming keys and never values.
 */
export interface BffConfig {
  bff_upstream_url?: string;
  bff_session_keys?: string;
  bff_csrf_key?: string;
  bff_allowed_origins?: string;
  bff_local_dev?: boolean;
  bff_trusted_documents?: boolean;
  /** GraphQL introspection; default: on outside production, off in production (FR-037). */
  bff_introspection?: boolean;
  bff_page_deadline_ms: number;
  bff_budget_product_ms: number;
  bff_budget_shop_ms: number;
  bff_budget_recommendations_ms: number;
  bff_budget_trending_ms: number;
  bff_budget_flags_ms: number;
  bff_budget_chat_ms: number;
  bff_budget_discussions_ms: number;
  bff_budget_videos_ms: number;
  bff_budget_pickup_ms: number;
  bff_budget_flash_sale_ms: number;
  bff_budget_auction_ms: number;
  bff_graphql_deadline_ms: number;
  bff_graphql_max_depth: number;
  bff_graphql_max_cost: number;
  bff_graphql_max_root_fields: number;
  bff_graphql_max_document_bytes: number;
  bff_graphql_max_ids: number;
  bff_graphql_batch_size: number;
  bff_graphql_shop_budget_ms: number;
  bff_breaker_failures: number;
  bff_breaker_window_ms: number;
  bff_breaker_open_ms: number;
  bff_gate_per_upstream: number;
  bff_gate_per_request: number;
  bff_cache_ceiling_ms: number;
  bff_session_idle_ms: number;
  bff_session_absolute_ms: number;
  bff_mfa_pending_ms: number;
  bff_refresh_skew_ms: number;
  bff_refresh_wait_ms: number;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const asBool = ((v: unknown) =>
  v === undefined || v === ''
    ? undefined
    : v === true || v === 'true') as never;
const optionalText = (name: string): Key => ({
  name,
  verify: joi.string().optional().allow(''),
});
// The range is part of the parse, so a bad value is reported by `parseBffSettings` with the key's name.
const int = (name: string, fallback: number): Key => ({
  name,
  verify: joi.number().required(),
  postProcess: ((v: unknown) =>
    v === undefined || v === '' ? fallback : Number(v)) as never,
});

export const bffConfigKeys: Record<keyof BffConfig, Key> = {
  bff_upstream_url: optionalText('BFF_UPSTREAM_URL'),
  bff_session_keys: optionalText('BFF_SESSION_KEYS'),
  bff_csrf_key: optionalText('BFF_CSRF_KEY'),
  bff_allowed_origins: optionalText('BFF_ALLOWED_ORIGINS'),
  bff_local_dev: {
    name: 'BFF_LOCAL_DEV',
    verify: joi.boolean().optional(),
    postProcess: asBool,
  },
  bff_trusted_documents: {
    name: 'BFF_TRUSTED_DOCUMENTS',
    verify: joi.boolean().optional(),
    postProcess: asBool,
  },
  bff_introspection: {
    name: 'BFF_INTROSPECTION',
    verify: joi.boolean().optional(),
    postProcess: asBool,
  },
  bff_page_deadline_ms: int('BFF_PAGE_DEADLINE_MS', 1_000),
  bff_budget_product_ms: int('BFF_BUDGET_PRODUCT_MS', 800),
  bff_budget_shop_ms: int('BFF_BUDGET_SHOP_MS', 300),
  bff_budget_recommendations_ms: int('BFF_BUDGET_RECOMMENDATIONS_MS', 300),
  bff_budget_trending_ms: int('BFF_BUDGET_TRENDING_MS', 200),
  bff_budget_flags_ms: int('BFF_BUDGET_FLAGS_MS', 150),
  bff_budget_chat_ms: int('BFF_BUDGET_CHAT_MS', 200),
  bff_budget_discussions_ms: int('BFF_BUDGET_DISCUSSIONS_MS', 300),
  bff_budget_videos_ms: int('BFF_BUDGET_VIDEOS_MS', 300),
  bff_budget_pickup_ms: int('BFF_BUDGET_PICKUP_MS', 300),
  bff_budget_flash_sale_ms: int('BFF_BUDGET_FLASH_SALE_MS', 200),
  bff_budget_auction_ms: int('BFF_BUDGET_AUCTION_MS', 200),
  bff_graphql_deadline_ms: int('BFF_GRAPHQL_DEADLINE_MS', 2_000),
  bff_graphql_max_depth: int('BFF_GRAPHQL_MAX_DEPTH', 6),
  bff_graphql_max_cost: int('BFF_GRAPHQL_MAX_COST', 2_000),
  bff_graphql_max_root_fields: int('BFF_GRAPHQL_MAX_ROOT_FIELDS', 20),
  bff_graphql_max_document_bytes: int('BFF_GRAPHQL_MAX_DOCUMENT_BYTES', 8_192),
  bff_graphql_max_ids: int('BFF_GRAPHQL_MAX_IDS', 50),
  bff_graphql_batch_size: int('BFF_GRAPHQL_BATCH_SIZE', 100),
  bff_graphql_shop_budget_ms: int('BFF_GRAPHQL_SHOP_BUDGET_MS', 500),
  bff_breaker_failures: int('BFF_BREAKER_FAILURES', 5),
  bff_breaker_window_ms: int('BFF_BREAKER_WINDOW_MS', 10_000),
  bff_breaker_open_ms: int('BFF_BREAKER_OPEN_MS', 10_000),
  bff_gate_per_upstream: int('BFF_GATE_PER_UPSTREAM', 100),
  bff_gate_per_request: int('BFF_GATE_PER_REQUEST', 12),
  bff_cache_ceiling_ms: int('BFF_CACHE_CEILING_MS', 30_000),
  bff_session_idle_ms: int('BFF_SESSION_IDLE_MS', 24 * 3_600_000),
  bff_session_absolute_ms: int('BFF_SESSION_ABSOLUTE_MS', 30 * 86_400_000),
  bff_mfa_pending_ms: int('BFF_MFA_PENDING_MS', 300_000),
  bff_refresh_skew_ms: int('BFF_REFRESH_SKEW_MS', 30_000),
  bff_refresh_wait_ms: int('BFF_REFRESH_WAIT_MS', 3_000),
};

export const BFF_SECTION_NAMES_FOR_BUDGET = [
  'product',
  'shop',
  'recommendations',
  'trending',
  'flags',
  'chatUnread',
  'discussions',
  'videos',
  'pickup',
  'flashSale',
  'auction',
] as const;
export type BffBudgetSection = (typeof BFF_SECTION_NAMES_FOR_BUDGET)[number];

export interface BffSettingsValues {
  /** `scheme://host[:port]` of the one domain-API origin; the only place a token is ever sent. */
  upstreamOrigin: string;
  /** Newest first; decryption tries each, encryption uses the first. */
  sessionKeys: Buffer[];
  csrfKey: Buffer;
  allowedOrigins: string[];
  localDev: boolean;
  trustedDocuments: boolean;
  introspection: boolean;
  pageDeadlineMs: number;
  budgetsMs: Record<BffBudgetSection, number>;
  graphql: {
    deadlineMs: number;
    maxDepth: number;
    maxCost: number;
    maxRootFields: number;
    maxDocumentBytes: number;
    maxIds: number;
    batchSize: number;
    shopBudgetMs: number;
  };
  breaker: { failures: number; windowMs: number; openMs: number };
  gate: { perUpstream: number; perRequest: number };
  cacheCeilingMs: number;
  session: {
    idleMs: number;
    absoluteMs: number;
    mfaPendingMs: number;
    refreshSkewMs: number;
    refreshWaitMs: number;
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const isSet = (v: unknown) => v !== undefined && v !== null && v !== '';

const parseKeyRing = (raw: unknown): { keys: Buffer[]; problems: string[] } => {
  if (!isSet(raw))
    return { keys: [], problems: ['bff_session_keys is required'] };
  const parts = String(raw)
    .split(',')
    .map((p) => p.trim());
  const keys = parts.map((p) => Buffer.from(p, 'base64'));
  const problems: string[] = [];
  if (parts.length < 1 || parts.length > 2)
    problems.push('bff_session_keys needs one or two keys');
  if (keys.some((k) => k.length !== 32))
    problems.push('bff_session_keys must hold base64 keys of 32 bytes');
  const digests = new Set(
    keys.map((k) => createHash('sha256').update(k).digest('hex')),
  );
  if (digests.size !== keys.length)
    problems.push('bff_session_keys must not repeat a key');
  return { keys, problems };
};

const checkOrigin = (
  key: string,
  value: string,
  production: boolean,
  allowLoopbackHttp: boolean,
): { origin?: string; problems: string[] } => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problems: [`${key} must hold valid origins`] };
  }
  const problems: string[] = [];
  if (url.pathname !== '/' || url.search || url.hash || url.username)
    problems.push(
      `${key} must be an origin without path, query or credentials`,
    );
  const loopbackHttp =
    allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(loopbackHttp && !production))
    problems.push(`${key} must use https`);
  return { origin: url.origin, problems };
};

const RANGES: Partial<Record<keyof BffConfig, [number, number]>> = {
  bff_page_deadline_ms: [1, 60_000],
  bff_budget_product_ms: [1, 60_000],
  bff_budget_shop_ms: [1, 60_000],
  bff_budget_recommendations_ms: [1, 60_000],
  bff_budget_trending_ms: [1, 60_000],
  bff_budget_flags_ms: [1, 60_000],
  bff_budget_chat_ms: [1, 60_000],
  bff_budget_discussions_ms: [1, 60_000],
  bff_budget_videos_ms: [1, 60_000],
  bff_budget_pickup_ms: [1, 60_000],
  bff_budget_flash_sale_ms: [1, 60_000],
  bff_budget_auction_ms: [1, 60_000],
  bff_graphql_deadline_ms: [1, 60_000],
  bff_graphql_max_depth: [1, 20],
  bff_graphql_max_cost: [1, 1_000_000],
  bff_graphql_max_root_fields: [1, 200],
  bff_graphql_max_document_bytes: [256, 1_048_576],
  bff_graphql_max_ids: [1, 100],
  bff_graphql_batch_size: [1, 100],
  bff_graphql_shop_budget_ms: [1, 60_000],
  bff_breaker_failures: [1, 1_000],
  bff_breaker_window_ms: [100, 3_600_000],
  bff_breaker_open_ms: [100, 3_600_000],
  bff_gate_per_upstream: [1, 100_000],
  bff_gate_per_request: [1, 1_000],
  bff_cache_ceiling_ms: [0, 30_000],
  bff_session_idle_ms: [60_000, 90 * 86_400_000],
  bff_session_absolute_ms: [60_000, 400 * 86_400_000],
  bff_mfa_pending_ms: [10_000, 3_600_000],
  bff_refresh_skew_ms: [0, 600_000],
  bff_refresh_wait_ms: [100, 60_000],
};

/**
 * Pure cross-checks of the BFF settings (S48 FR-051, AS-37, AS-63). Throws one error listing every violation by key.
 * `production` is `NODE_ENV === 'production'`.
 */
export function parseBffSettings(
  raw: Partial<BffConfig>,
  { production }: { production: boolean },
): BffSettingsValues {
  const problems: string[] = [];
  const num = (key: keyof BffConfig, fallback: number): number => {
    const value = raw[key];
    const n = value === undefined ? fallback : Number(value);
    const range = RANGES[key];
    if (!Number.isInteger(n) || (range && (n < range[0] || n > range[1])))
      problems.push(`${key} is out of range`);
    return n;
  };

  const localDev = raw.bff_local_dev === true;

  let upstreamOrigin = '';
  if (!isSet(raw.bff_upstream_url))
    problems.push('bff_upstream_url is required');
  else {
    const checked = checkOrigin(
      'bff_upstream_url',
      String(raw.bff_upstream_url),
      production,
      true,
    );
    problems.push(...checked.problems);
    upstreamOrigin = checked.origin ?? '';
  }

  const ring = parseKeyRing(raw.bff_session_keys);
  problems.push(...ring.problems);

  const csrf = isSet(raw.bff_csrf_key)
    ? Buffer.from(String(raw.bff_csrf_key), 'base64')
    : Buffer.alloc(0);
  if (!isSet(raw.bff_csrf_key)) problems.push('bff_csrf_key is required');
  else if (csrf.length < 32)
    problems.push('bff_csrf_key must hold a base64 key of at least 32 bytes');

  const allowedOrigins: string[] = [];
  if (!isSet(raw.bff_allowed_origins))
    problems.push('bff_allowed_origins is required');
  else
    for (const part of String(raw.bff_allowed_origins).split(',')) {
      const checked = checkOrigin(
        'bff_allowed_origins',
        part.trim(),
        production,
        true,
      );
      problems.push(...checked.problems);
      if (checked.origin) allowedOrigins.push(checked.origin);
    }

  const trustedDocuments = raw.bff_trusted_documents ?? !localDev;
  if (production && !localDev && !trustedDocuments)
    problems.push(
      'bff_trusted_documents must be on in production (set bff_local_dev to opt out explicitly)',
    );

  const settings: BffSettingsValues = {
    upstreamOrigin,
    sessionKeys: ring.keys,
    csrfKey: csrf,
    allowedOrigins,
    localDev,
    trustedDocuments,
    introspection: raw.bff_introspection ?? !production,
    pageDeadlineMs: num('bff_page_deadline_ms', 1_000),
    budgetsMs: {
      product: num('bff_budget_product_ms', 800),
      shop: num('bff_budget_shop_ms', 300),
      recommendations: num('bff_budget_recommendations_ms', 300),
      trending: num('bff_budget_trending_ms', 200),
      flags: num('bff_budget_flags_ms', 150),
      chatUnread: num('bff_budget_chat_ms', 200),
      discussions: num('bff_budget_discussions_ms', 300),
      videos: num('bff_budget_videos_ms', 300),
      pickup: num('bff_budget_pickup_ms', 300),
      flashSale: num('bff_budget_flash_sale_ms', 200),
      auction: num('bff_budget_auction_ms', 200),
    },
    graphql: {
      deadlineMs: num('bff_graphql_deadline_ms', 2_000),
      maxDepth: num('bff_graphql_max_depth', 6),
      maxCost: num('bff_graphql_max_cost', 2_000),
      maxRootFields: num('bff_graphql_max_root_fields', 20),
      maxDocumentBytes: num('bff_graphql_max_document_bytes', 8_192),
      maxIds: num('bff_graphql_max_ids', 50),
      batchSize: num('bff_graphql_batch_size', 100),
      shopBudgetMs: num('bff_graphql_shop_budget_ms', 500),
    },
    breaker: {
      failures: num('bff_breaker_failures', 5),
      windowMs: num('bff_breaker_window_ms', 10_000),
      openMs: num('bff_breaker_open_ms', 10_000),
    },
    gate: {
      perUpstream: num('bff_gate_per_upstream', 100),
      perRequest: num('bff_gate_per_request', 12),
    },
    cacheCeilingMs: num('bff_cache_ceiling_ms', 30_000),
    session: {
      idleMs: num('bff_session_idle_ms', 24 * 3_600_000),
      absoluteMs: num('bff_session_absolute_ms', 30 * 86_400_000),
      mfaPendingMs: num('bff_mfa_pending_ms', 300_000),
      refreshSkewMs: num('bff_refresh_skew_ms', 30_000),
      refreshWaitMs: num('bff_refresh_wait_ms', 3_000),
    },
  };

  if (problems.length > 0)
    throw new Error(`BFF configuration error: ${problems.join('; ')}`);
  return settings;
}
