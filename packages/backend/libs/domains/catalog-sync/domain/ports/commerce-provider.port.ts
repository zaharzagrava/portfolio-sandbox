import type { BreakerState } from '../breaker';
import type {
  NormaliseContext,
  NormaliseResult,
  ProviderName,
} from '../normalise';

/**
 * Provider port (contracts/ports.md): one `CommerceProvider` per provider, registered under `COMMERCE_PROVIDERS`.
 * Adapters live in `infra/`; the sync engine sees only these shapes (anti-corruption layer). There is no fake provider
 * in production wiring: tests point the adapters at HTTP fakes through the call stack's explicit test option.
 */
export const COMMERCE_PROVIDERS = Symbol('COMMERCE_PROVIDERS');

export type { ProviderName };

/** Rate-limit policies that guard provider calls: one token bucket per credential, shared by every worker (FR-052). */
export type ProviderRatePolicy =
  'integrations.shopify' | 'integrations.woocommerce';

// ---- call policy (limiter + breaker + retry), used by the adapters -------------------------------------------------

export interface ProviderRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Relative to the provider's API root (`scope: 'api'`, default) or to the store origin (`scope: 'origin'`). */
  path: string;
  scope?: 'api' | 'origin';
  query?: Record<string, string | number | undefined>;
  /** Sent as JSON. */
  body?: unknown;
  /** Only idempotent operations are retried (AS-57). */
  idempotent: boolean;
  /** Default true: sends the credential. `false` for the OAuth exchange. */
  auth?: boolean;
  /** Envelope check of a successful answer (A19); `false` or a throw = `schema_invalid` and one breaker failure. */
  validate?: (json: unknown) => boolean;
}

export interface ProviderResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Parsed JSON body; `undefined` when the body is empty. */
  json: unknown;
  /** The `Link: rel="next"` target, already checked against the store's host, scheme and API path. */
  nextUrl: URL | null;
  /** HTTP requests made for this call (1 + retries). */
  attempts: number;
}

export type ProviderCallErrorKind =
  /** The limiter store is down and the policy fails closed: yield, make no provider call. */
  | 'rate_limiter_unavailable'
  /** Another worker's `429` paused the bucket: yield with `retryAfterMs`. */
  | 'paused'
  /** The provider answered `429` and the call was not (or no longer) retried inline: yield with `retryAfterMs`. */
  | 'rate_limited'
  /** The breaker is open: no provider call was made (`skipped_breaker_open`). */
  | 'breaker_open'
  /** `401` that a token refresh did not fix (or no refresh is possible): the integration needs re-authorisation. */
  | 'auth_failed'
  | 'forbidden'
  /** `404`: on a single-item read this means "gone" (AS-30). */
  | 'gone'
  /** Any other `4xx` (`400`, `422`, ...): permanent, never retried. */
  | 'rejected'
  /** `5xx` after the retries. */
  | 'unavailable'
  | 'timeout'
  | 'network'
  /** The address is not allowed, or the provider redirected (AS-07). */
  | 'blocked_address'
  /** Envelope, body or `Link` header invalid (AS-54). */
  | 'schema_invalid';

/** Typed failure of a provider call. The message is generic: never a URL, token, header or response text. */
export class ProviderCallError extends Error {
  constructor(
    readonly kind: ProviderCallErrorKind,
    readonly details: {
      status?: number;
      retryAfterMs?: number;
      /** Parsed error body of a `rejected`/`forbidden` answer, for the adapter's own mapping only. */
      body?: unknown;
      attempts?: number;
    } = {},
  ) {
    super(`provider call failed: ${kind}`);
    this.name = 'ProviderCallError';
  }
  get status(): number | undefined {
    return this.details.status;
  }
  get retryAfterMs(): number | undefined {
    return this.details.retryAfterMs;
  }
  /** The run should end `yielded` (not `failed`) and continue later. */
  get isYield(): boolean {
    return (
      this.kind === 'rate_limiter_unavailable' ||
      this.kind === 'paused' ||
      this.kind === 'rate_limited'
    );
  }
}

/** One call to the provider through limiter -> breaker -> safe HTTP -> classify -> retry (T013). */
export interface ProviderCallPolicy {
  call(request: ProviderRequest): Promise<ProviderResponse>;
}

/** Breaker state persistence behind the call stack (the `Integration` row, wired by T032). */
export interface BreakerStep<T> {
  /** The state to store. */
  state: BreakerState;
  result: T;
  /** The breaker opened (or reopened) with this step. */
  opened?: boolean;
  /** The one `integration_attention_required {breaker_open}` event is due. */
  raiseAttention?: boolean;
}

export interface BreakerPersistence {
  /** Plain read, used to skip the locked update when the breaker is pristine (the hot path). */
  load(): Promise<BreakerState>;
  /**
   * Atomic read-modify-write of the stored state (a row lock in production): `step` sees the current state and returns
   * the state to store. Atomicity is what lets exactly one caller win the probe after the open period (AS-59).
   */
  update<T>(step: (current: BreakerState) => BreakerStep<T>): Promise<T>;
}

/** Structural subset of `RateLimiterService` used by the call stack. */
export interface ProviderLimiter {
  check(
    policy: ProviderRatePolicy,
    subject: string,
    cost?: number,
  ): Promise<{
    allowed: boolean;
    retryAfterMs: number | null;
    reason?:
      'limit-exceeded' | 'store-unavailable' | 'cost-exceeds-limit' | 'paused';
  }>;
  penalize(
    policy: ProviderRatePolicy,
    subject: string,
    ms: number,
  ): Promise<boolean>;
}

/** Credential source of one call stack. `tokenId` identifies the token used (a fingerprint, never the token). */
export interface ProviderAuth {
  /** Reads the stored credential now (after a refresh by another worker this returns the new one). */
  current(): Promise<{ headers: Record<string, string>; tokenId: string }>;
  /** Refreshes with the provider and stores the new token sealed; `false` = no refresh token or refused. */
  refresh?(): Promise<boolean>;
}

/** Lock for the single-flight refresh (Redis in production). Returns a release function or `null` when taken. */
export interface RefreshLock {
  acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
}

// ---- provider operations ------------------------------------------------------------------------------------------

export interface ProviderSession {
  call: ProviderCallPolicy;
}

export interface SyncSession extends ProviderSession {
  integrationId: string;
  normalise: NormaliseContext;
  /** Shopify: the location chosen at connect time. */
  locationId?: string;
}

export interface Page<T> {
  items: T[];
  /** Opaque; `null` on the last page. */
  nextCursor: string | null;
}

/** One provider product with the normalisation result of each of its variants (`raw` is what the link stores). */
export interface RawItem {
  /** Provider product id. */
  productId: string;
  raw: unknown;
  /** One result per variant (Shopify) / simple product or variation (WooCommerce); `externalId` is `<product>:<variant>`. */
  results: NormaliseResult[];
}

export interface RemoteDigest {
  externalId: string;
  digest: string;
  stock: number;
}

export type StockWriteOutcome = 'accepted' | 'precondition_failed' | 'gone';

export interface ConnectionFacts {
  currency: string;
  /** Shopify primary location; `null` for WooCommerce. */
  locationId: string | null;
}

export interface WebhookSubscription {
  topic: string;
  id: string;
}

export interface RegisteredWebhooks {
  subscriptions: WebhookSubscription[];
  /** Secret the provider signs with when it is per integration (WooCommerce); `null` when the app secret is used. */
  webhookSecret: string | null;
}

export type WebhookTopic =
  | 'product_changed'
  | 'product_deleted'
  | 'inventory_changed'
  | 'app_uninstalled'
  | 'ping'
  | 'ignored';

export interface ParsedWebhook {
  topic: WebhookTopic;
  rawTopic: string;
  deliveryId: string;
  /** ISO timestamp when the provider supplies one (Shopify). */
  triggeredAt?: string;
  /** `<productId>` or `<productId>:<variantId>`. */
  externalId?: string;
  inventoryItemId?: string;
}

export interface OAuthTokens {
  accessToken: string;
  scope: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface CommerceProvider {
  readonly name: ProviderName;
  /** Shopify only. */
  buildAuthorizeUrl?(input: {
    shopDomain: string;
    state: string;
    redirectUri: string;
  }): string;
  /** Shopify only: HMAC over the sorted query, constant-time, timestamp within 5 minutes. `null` = reject. */
  verifyCallback?(
    query: Record<string, string>,
    now: Date,
  ): { shop: string; code: string; state: string } | null;
  /** Shopify only. */
  exchangeCode?(
    session: ProviderSession,
    input: { shopDomain: string; code: string },
  ): Promise<OAuthTokens>;
  verifyCredentials(session: ProviderSession): Promise<ConnectionFacts>;
  listChanged(
    session: SyncSession,
    input: { since: Date | null; pageCursor: string | null },
  ): Promise<Page<RawItem>>;
  listAllIdsAndDigests(
    session: SyncSession,
    input: { pageCursor: string | null },
  ): Promise<Page<RemoteDigest>>;
  /** `null` = gone at the provider. Accepts `<productId>` or `<productId>:<variantId>`. */
  fetchOne(session: SyncSession, externalId: string): Promise<RawItem | null>;
  setStock(
    session: SyncSession,
    externalId: string,
    value: number,
    expected: number,
  ): Promise<StockWriteOutcome>;
  registerWebhooks(
    session: ProviderSession,
    input: { callbackUrl: string; secret?: string },
  ): Promise<RegisteredWebhooks>;
  deregisterWebhooks(
    session: ProviderSession,
    subscriptions: WebhookSubscription[],
  ): Promise<void>;
  /** Lists the store's subscriptions that deliver to `callbackUrl` and deletes them (disconnect; the ids are not stored). */
  deregisterWebhooksAt(
    session: ProviderSession,
    input: { callbackUrl: string },
  ): Promise<void>;
  /** Pure; `null` when the body is not understood. Call only after `verifyWebhook`. */
  parseWebhook(headers: WebhookHeaders, rawBody: Buffer): ParsedWebhook | null;
  /** Constant-time signature check over the raw bytes. `secret`: per-integration secret (WooCommerce); Shopify uses the app secret. */
  verifyWebhook(
    headers: WebhookHeaders,
    rawBody: Buffer,
    secret?: string,
  ): boolean;
  refreshToken?(
    session: ProviderSession,
    input: { refreshToken: string },
  ): Promise<OAuthTokens | null>;
}
