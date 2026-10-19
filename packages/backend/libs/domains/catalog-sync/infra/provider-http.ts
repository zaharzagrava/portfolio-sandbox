import { randomUUID } from 'node:crypto';
import { Clock, SystemClock } from '@app/common/core/clock';
import { safeRequest, SafeRequestError } from '@app/infrastructure/net';
import type { SafeUrlOptions } from '@app/infrastructure/net';
import type { HostResolver } from '@app/infrastructure/net/ssrf-guard';
import type { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  initialBreaker,
  recordFailure,
  recordSuccess,
  tryAcquire,
  type BreakerState,
} from '../domain/breaker';
import {
  ProviderCallError,
  type BreakerPersistence,
  type BreakerStep,
  type ProviderAuth,
  type ProviderCallPolicy,
  type ProviderLimiter,
  type ProviderRatePolicy,
  type ProviderRequest,
  type ProviderResponse,
  type RefreshLock,
} from '../domain/ports/commerce-provider.port';
import {
  retryDelayMs,
  shouldRetry,
  type CallFailure,
} from '../domain/retry-policy';

export const PROVIDER_TIMEOUT_MS = 15_000;
/** Longest wait done inline (a `Retry-After`, a bucket refill); beyond it the run yields (AS-56). */
export const MAX_INLINE_WAIT_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_LIMIT_WAITS = 10;
const REFRESH_LOCK_TTL_MS = 30_000;
const REFRESH_WAIT_MS = 15_000;

export interface ProviderCallEvent {
  provider: string;
  /** HTTP status, or the failure kind for a call that got no answer. */
  outcome: number | 'timeout' | 'network' | 'blocked' | 'schema_invalid';
  attempt: number;
}

/**
 * TEST ONLY. Lets the call stack reach a plain-HTTP fake on 127.0.0.1. Never set by production wiring: the safe-request
 * layer refuses these hatches when `NODE_ENV=production`, and this constructor refuses them too.
 */
export type UnsafeTestNetwork = Pick<
  SafeUrlOptions,
  | 'allowHttpHosts'
  | 'allowPrivateHosts'
  | 'allowSelfSignedHosts'
  | 'testTransport'
>;

export interface ProviderHttpOptions {
  provider: 'shopify' | 'woocommerce';
  /** Token bucket policy of the provider. */
  policy: ProviderRatePolicy;
  /** Bucket subject: the provider credential (one bucket for every worker). */
  credentialId: string;
  /** `https://store.example.com` (scheme, host, no path). */
  origin: string;
  /** API root path below the origin, e.g. `/admin/api/2025-07` or `/wp-json/wc/v3`. `Link` targets must stay below it. */
  apiPath: string;
  limiter: ProviderLimiter;
  breaker: BreakerPersistence;
  auth?: ProviderAuth;
  /** Needed for single-flight token refresh; without it a `401` goes straight to `auth_failed`. */
  refreshLock?: RefreshLock;
  clock?: Clock;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** DNS resolver (stubbed in tests). */
  resolver?: HostResolver;
  timeoutMs?: number;
  maxInlineWaitMs?: number;
  onCall?: (event: ProviderCallEvent) => void;
  unsafeTestNetwork?: UnsafeTestNetwork;
}

type Attempt =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: string;
      truncated: boolean;
    }
  | { ok: false; failure: CallFailure | { kind: 'blocked' } };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Provider call stack, one instance per credential (T013, FR-052, AS-54..AS-60):
 * limiter `check` (fail closed) -> breaker gate -> `safeRequest` (15 s, HTTPS/443, redirects refused, resolved address
 * checked on every call) -> classify -> retry (<= 3, idempotent only, full jitter) -> `429` penalises the shared bucket
 * -> `401` single-flight refresh, else `auth_failed` -> envelope and `Link` validation.
 * The breaker is persisted through `BreakerPersistence`; the stack never changes the integration status itself.
 */
export class ProviderHttp implements ProviderCallPolicy {
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxInlineWaitMs: number;
  private readonly origin: URL;
  private readonly apiPath: string;

  constructor(private readonly options: ProviderHttpOptions) {
    if (options.unsafeTestNetwork && process.env.NODE_ENV === 'production')
      throw new Error('unsafeTestNetwork is not allowed in production');
    this.clock = options.clock ?? new SystemClock();
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? realSleep;
    this.timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    this.maxInlineWaitMs = options.maxInlineWaitMs ?? MAX_INLINE_WAIT_MS;
    this.origin = new URL(options.origin);
    this.apiPath = options.apiPath.replace(/\/+$/, '');
  }

  async call(request: ProviderRequest): Promise<ProviderResponse> {
    await this.waitForBucket(false);
    const probing = await this.gate();
    let attempt = 0;
    let refreshed = false;

    for (;;) {
      attempt++;
      if (attempt > 1) await this.waitForBucket(true);

      const used =
        request.auth === false ? undefined : await this.options.auth?.current();
      const result = await this.once(request, used?.headers ?? {});
      this.options.onCall?.({
        provider: this.options.provider,
        outcome: result.ok
          ? result.status
          : result.failure.kind === 'http'
            ? result.failure.status
            : result.failure.kind === 'blocked'
              ? 'blocked'
              : result.failure.kind,
        attempt,
      });

      if (!result.ok) {
        const { failure } = result;
        if (failure.kind === 'blocked') {
          await this.succeeded();
          throw new ProviderCallError('blocked_address', { attempts: attempt });
        }
        if (shouldRetry({ failure, attempt, idempotent: request.idempotent })) {
          await this.sleep(retryDelayMs(attempt, this.random));
          continue;
        }
        await this.failed(probing);
        throw new ProviderCallError(
          failure.kind === 'timeout' ? 'timeout' : 'network',
          { attempts: attempt },
        );
      }

      const { status } = result;
      if (status >= 200 && status < 300)
        return this.accept(request, result, attempt, probing);

      if (status >= 300 && status < 400) {
        await this.succeeded();
        throw new ProviderCallError('blocked_address', {
          status,
          attempts: attempt,
        });
      }

      if (status === 401) {
        await this.succeeded();
        if (
          !refreshed &&
          request.auth !== false &&
          used &&
          this.options.auth?.refresh &&
          this.options.refreshLock
        ) {
          refreshed = true;
          if (await this.refreshSingleFlight(used.tokenId)) continue;
        }
        throw new ProviderCallError(
          request.auth === false ? 'rejected' : 'auth_failed',
          {
            status,
            attempts: attempt,
          },
        );
      }

      if (status === 429) {
        const retryAfterMs =
          parseRetryAfter(result.headers['retry-after'], this.clock.now()) ??
          DEFAULT_RETRY_AFTER_MS;
        await this.options.limiter.penalize(
          this.options.policy,
          this.options.credentialId,
          retryAfterMs,
        );
        await this.succeeded();
        const retryable = shouldRetry({
          failure: { kind: 'http', status },
          attempt,
          idempotent: request.idempotent,
        });
        if (!retryable || retryAfterMs > this.maxInlineWaitMs)
          throw new ProviderCallError('rate_limited', {
            status,
            retryAfterMs,
            attempts: attempt,
          });
        await this.sleep(retryAfterMs);
        continue;
      }

      if (status >= 500) {
        const failure: CallFailure = { kind: 'http', status };
        if (shouldRetry({ failure, attempt, idempotent: request.idempotent })) {
          await this.sleep(retryDelayMs(attempt, this.random));
          continue;
        }
        await this.failed(probing);
        throw new ProviderCallError('unavailable', {
          status,
          attempts: attempt,
        });
      }

      // 4xx the provider answered on purpose: it is up, the request is wrong.
      await this.succeeded();
      const body = tryJson(result.body);
      if (status === 404)
        throw new ProviderCallError('gone', { status, attempts: attempt });
      if (status === 403)
        throw new ProviderCallError('forbidden', {
          status,
          body,
          attempts: attempt,
        });
      throw new ProviderCallError('rejected', {
        status,
        body,
        attempts: attempt,
      });
    }
  }

  // ---- gates -----------------------------------------------------------------------------------------------------

  /**
   * Limiter check, fail closed. First check of a call: a bucket paused by another worker's `429` yields with
   * `retryAfterMs`. Later checks (our own retry) wait inline up to the inline budget.
   */
  private async waitForBucket(isRetry: boolean): Promise<void> {
    for (let waits = 0; ; waits++) {
      let decision: Awaited<ReturnType<ProviderLimiter['check']>>;
      try {
        decision = await this.options.limiter.check(
          this.options.policy,
          this.options.credentialId,
        );
      } catch {
        throw new ProviderCallError('rate_limiter_unavailable');
      }
      if (decision.allowed) return;
      if (decision.reason === 'store-unavailable')
        throw new ProviderCallError('rate_limiter_unavailable');
      const wait = decision.retryAfterMs;
      if (decision.reason === 'paused' && !isRetry)
        throw new ProviderCallError('paused', {
          retryAfterMs: wait ?? DEFAULT_RETRY_AFTER_MS,
        });
      if (
        wait === null ||
        wait > this.maxInlineWaitMs ||
        waits >= MAX_LIMIT_WAITS
      )
        throw new ProviderCallError('rate_limited', {
          retryAfterMs: wait ?? DEFAULT_RETRY_AFTER_MS,
        });
      await this.sleep(Math.max(1, wait));
    }
  }

  /** Breaker gate: closed lets the call through, open blocks it, after the open period exactly one caller probes. */
  private async gate(): Promise<boolean> {
    const now = this.clock.now();
    const verdict = await this.options.breaker.update((current) => {
      const acquired = tryAcquire(current, now);
      return {
        state: acquired.state,
        result: { decision: acquired.decision, openUntil: current.openUntil },
      };
    });
    if (verdict.decision === 'blocked')
      throw new ProviderCallError('breaker_open', {
        retryAfterMs: Math.max(
          0,
          (verdict.openUntil?.getTime() ?? 0) - now.getTime(),
        ),
      });
    return verdict.decision === 'probe';
  }

  /** The provider answered (even with a refusal): closes a failing or probing breaker. */
  private async succeeded(): Promise<void> {
    const current = await this.options.breaker.load();
    if (
      current.failures === 0 &&
      current.openUntil === null &&
      !current.halfOpen
    )
      return;
    await this.options.breaker.update((state) => ({
      state: recordSuccess(state),
      result: undefined,
    }));
  }

  /**
   * A failed call after retries. `probing` = this call is the one probe handed out after the open period: its failure
   * reopens the breaker even when the stored state cannot say "half-open" (the integration row keeps only the lease).
   */
  private async failed(probing = false): Promise<void> {
    const now = this.clock.now();
    await this.options.breaker.update((current) => {
      const outcome = recordFailure(
        probing ? { ...current, halfOpen: true } : current,
        now,
      );
      return {
        state: outcome.state,
        result: undefined,
        opened: outcome.opened,
        raiseAttention: outcome.raiseAttention,
      };
    });
  }

  // ---- success path ----------------------------------------------------------------------------------------------

  private async accept(
    request: ProviderRequest,
    result: Extract<Attempt, { ok: true }>,
    attempts: number,
    probing: boolean,
  ): Promise<ProviderResponse> {
    const invalid = async (): Promise<never> => {
      this.options.onCall?.({
        provider: this.options.provider,
        outcome: 'schema_invalid',
        attempt: attempts,
      });
      await this.failed(probing);
      throw new ProviderCallError('schema_invalid', {
        status: result.status,
        attempts,
      });
    };
    if (result.truncated) return invalid();
    let json: unknown;
    if (result.body.trim() !== '') {
      try {
        json = JSON.parse(result.body);
      } catch {
        return invalid();
      }
    }
    let nextUrl: URL | null;
    try {
      nextUrl = this.checkedNextLink(result.headers.link);
    } catch {
      return invalid();
    }
    if (request.validate) {
      let ok = false;
      try {
        ok = request.validate(json);
      } catch {
        ok = false;
      }
      if (!ok) return invalid();
    }
    await this.succeeded();
    return {
      status: result.status,
      headers: result.headers,
      json,
      nextUrl,
      attempts,
    };
  }

  /** `Link: rel="next"` must stay on the store's host and scheme, below the API path (A18, AS-54). */
  private checkedNextLink(header: string | undefined): URL | null {
    if (!header) return null;
    for (const match of header.matchAll(/<([^>]*)>\s*((?:;\s*[^;,]*)*)/g)) {
      if (!/;\s*rel\s*=\s*"?[^";,]*\bnext\b/i.test(match[2])) continue;
      const target = new URL(match[1], this.origin);
      const path = target.pathname;
      const inside =
        path === this.apiPath || path.startsWith(`${this.apiPath}/`);
      if (
        target.origin !== this.origin.origin ||
        target.username ||
        target.password ||
        !inside
      )
        throw new Error('link target outside the store API');
      return target;
    }
    return null;
  }

  // ---- HTTP ------------------------------------------------------------------------------------------------------

  private async once(
    request: ProviderRequest,
    authHeaders: Record<string, string>,
  ): Promise<Attempt> {
    const base = request.scope === 'origin' ? '' : this.apiPath;
    const url = new URL(`${this.origin.origin}${base}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'marketplace-catalog-sync/1.0',
      'accept-encoding': 'identity',
      ...authHeaders,
    };
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      headers['content-type'] = 'application/json';
    }
    try {
      const res = await safeRequest({
        method: request.method,
        url: url.toString(),
        headers,
        body,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        allowedPorts: [443],
        followRedirects: false,
        resolver: this.options.resolver,
        clock: this.clock,
        ...this.options.unsafeTestNetwork,
      });
      const flat: Record<string, string> = {};
      for (const [name, value] of Object.entries(res.headers))
        if (value !== undefined)
          flat[name.toLowerCase()] = Array.isArray(value)
            ? value.join(', ')
            : String(value);
      return {
        ok: true,
        status: res.status,
        headers: flat,
        body: res.body,
        truncated: res.truncated,
      };
    } catch (error) {
      if (!(error instanceof SafeRequestError)) throw error;
      switch (error.kind) {
        case 'timeout':
          return { ok: false, failure: { kind: 'timeout' } };
        case 'network_error':
        case 'tls_error':
        case 'unresolvable':
          return { ok: false, failure: { kind: 'network' } };
        default:
          return { ok: false, failure: { kind: 'blocked' } };
      }
    }
  }

  // ---- token refresh ---------------------------------------------------------------------------------------------

  /**
   * One refresh per credential across all workers: take the lock, re-read the stored token, and refresh only when it is
   * still the one that got the `401` (a worker that waited finds the new token and just retries).
   */
  private async refreshSingleFlight(usedTokenId: string): Promise<boolean> {
    const { auth, refreshLock } = this.options;
    const key = `catalog-sync:token-refresh:${this.options.credentialId}`;
    const deadline = this.clock.nowMs() + REFRESH_WAIT_MS;
    for (;;) {
      let release: (() => Promise<void>) | null;
      try {
        release = await refreshLock!.acquire(key, REFRESH_LOCK_TTL_MS);
      } catch {
        throw new ProviderCallError('unavailable');
      }
      if (release) {
        try {
          const current = await auth!.current();
          if (current.tokenId !== usedTokenId) return true;
          return await auth!.refresh!();
        } finally {
          await release().catch(() => undefined);
        }
      }
      if (this.clock.nowMs() >= deadline) return false;
      await this.sleep(50);
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------------------------------

/** `Retry-After`: delta-seconds or an HTTP date; `null` when absent or unusable. */
export function parseRetryAfter(
  value: string | undefined,
  now: Date,
): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.ceil(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
}

function tryJson(text: string): unknown {
  try {
    return text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Breaker kept in memory (tests, and a stack that does not persist). Production uses the `Integration` columns (T032). */
export class InMemoryBreakerPersistence implements BreakerPersistence {
  state: BreakerState = initialBreaker();
  readonly changes: {
    state: BreakerState;
    opened: boolean;
    raiseAttention: boolean;
  }[] = [];
  load(): Promise<BreakerState> {
    return Promise.resolve({ ...this.state });
  }
  update<T>(step: (current: BreakerState) => BreakerStep<T>): Promise<T> {
    // No await between read and write: atomic within the process.
    const out = step({ ...this.state });
    this.state = { ...out.state };
    if (out.opened || out.raiseAttention)
      this.changes.push({
        state: { ...out.state },
        opened: !!out.opened,
        raiseAttention: !!out.raiseAttention,
      });
    return Promise.resolve(out.result);
  }
}

/** Single-process lock (tests). */
export class InMemoryRefreshLock implements RefreshLock {
  private readonly held = new Set<string>();
  acquire(key: string, _ttlMs?: number): Promise<(() => Promise<void>) | null> {
    if (this.held.has(key)) return Promise.resolve(null);
    this.held.add(key);
    return Promise.resolve(() => {
      this.held.delete(key);
      return Promise.resolve();
    });
  }
}

const RELEASE_IF_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/** Redis lock (`SET NX PX`, release only by the owner): the single-flight guard shared by all worker instances. */
export class RedisRefreshLock implements RefreshLock {
  constructor(private readonly redis: RedisService) {}
  async acquire(
    key: string,
    ttlMs: number,
  ): Promise<(() => Promise<void>) | null> {
    const token = randomUUID();
    const ok = await this.redis.client.set(key, token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    return async () =>
      void (await this.redis.client.eval(RELEASE_IF_OWNER, 1, key, token));
  }
}
