import { Logger } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { Agent, Dispatcher, request } from 'undici';
import { ClsServiceManager } from 'nestjs-cls';
import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  BackoffOptions,
  fullJitterBackoff,
  sleep,
} from '@app/common/core/backoff';
import { Clock, SystemClock } from '@app/common/core/clock';
import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitOpenError,
} from '@app/common/resilience';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { AppClsStore } from '@app/common/request-context/types';
import { assertNoActiveTransaction } from '@app/infrastructure/context/transaction-scope';
import { Bulkhead, BulkheadOptions, DEFAULT_BULKHEAD } from './bulkhead';
import { HttpClientError } from './http-client-error';
import { resolveMaxAttempts, RetryOptions } from './retry-options';
import { RetryBudget } from './retry-budget';

export interface HttpRequestOptions<T = unknown> {
  method?: Dispatcher.HttpMethod;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Time for one attempt including the body read. Every outbound call has one (lesson 06/03 §1). Default 10 s. */
  timeoutMs?: number;
  /** Absolute deadline (epoch ms) for the whole call; the request context's deadline applies too, the earlier wins. */
  deadlineAt?: number;
  /** Retries only happen when the operation is safe (GET, HEAD, OPTIONS) or the caller declares it idempotent. */
  idempotent?: boolean;
  /** Total attempts including the first; limited by the retry profile (3 sync, 6 background). */
  maxAttempts?: number;
  /** Response body cap in bytes. Default 1 MiB. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
  /** Returned (flagged `degraded`) instead of failing when the circuit is open. */
  fallback?: () => Promise<T> | T;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
  /** True when the body came from `fallback` because the circuit is open. */
  degraded?: boolean;
}

export type BreakerSettings = Omit<CircuitBreakerOptions, 'name' | 'clock'>;

export interface ResilientHttpClientOptions {
  /** Dependency name: the only identifier in logs and metric labels besides the host. */
  name: string;
  /** Internal dependencies receive `X-Request-Id`; third parties never do. */
  internal?: boolean;
  maxConcurrent?: number;
  bulkhead?: Partial<Pick<BulkheadOptions, 'maxQueue' | 'queueWaitMs'>>;
  /** `false` turns the breaker off. */
  breaker?: BreakerSettings | false;
  retry?: RetryOptions & { backoff?: BackoffOptions };
  clock?: Clock;
  dispatcher?: Dispatcher;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 502, 503, 504]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_TIMEOUT_MS = 10_000;
const OVERALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 3_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 100, maxMs: 5_000 };
const DEFAULT_BREAKER: BreakerSettings = {
  windowMs: 10_000,
  minimumCalls: 20,
  failureRateThreshold: 0.5,
  openDurationMs: 30_000,
  halfOpenCalls: 3,
};

const requests = () =>
  MetricsRegistry.counter({
    name: 'http_client_requests_total',
    help: 'Outbound calls by dependency and outcome',
    labels: ['dependency', 'outcome'],
  });
const retriesCounter = () =>
  MetricsRegistry.counter({
    name: 'http_client_retries_total',
    help: 'Outbound retries by dependency',
    labels: ['dependency'],
  });
const exhaustedCounter = () =>
  MetricsRegistry.counter({
    name: 'http_client_retry_budget_exhausted_total',
    help: 'Retries refused because the host retry budget was spent',
    labels: ['dependency'],
  });

/** A breaker counts timeouts, resets and 5xx; client errors (4xx), caller aborts and a full bulkhead say nothing about the dependency. */
const countsAsFailure = (error: unknown): boolean => {
  if (!(error instanceof HttpClientError)) return true;
  if (error.status !== undefined) return error.status >= 500;
  return (
    error.kind === 'timeout' ||
    error.kind === 'network_error' ||
    error.kind === 'invalid_response' ||
    error.kind === 'response_too_large'
  );
};

const currentContext = (): Partial<AppClsStore> => {
  try {
    const cls = ClsServiceManager.getClsService<AppClsStore>();
    return cls.isActive()
      ? {
          requestId: cls.get('requestId'),
          traceparent: cls.get('traceparent'),
          deadlineAt: cls.get('deadlineAt'),
        }
      : {};
  } catch {
    return {};
  }
};

/**
 * Outbound HTTP for third-party and internal APIs (Shopify sync, webhooks, core, LLM providers): keep-alive pool,
 * connect/attempt/overall timeouts that respect the request context's deadline, retries only for transient failures of
 * idempotent calls with full-jitter backoff and `Retry-After`, a per-host retry budget, a response size cap,
 * a bulkhead and a circuit breaker per dependency, and W3C trace propagation. No redirects are followed.
 */
export class ResilientHttpClient {
  private readonly logger = new Logger(ResilientHttpClient.name);
  readonly name: string;
  readonly internal: boolean;
  /** Idle keep-alive timeout of pooled connections; kept below the 65 s of our servers and load balancers. */
  readonly idleTimeoutMs = IDLE_TIMEOUT_MS;
  private readonly clock: Clock;
  private readonly dispatcher: Dispatcher;
  private readonly budget: RetryBudget;
  private readonly bulkhead: Bulkhead;
  private readonly breaker?: CircuitBreaker;
  private readonly retry: RetryOptions & { backoff: BackoffOptions };

  private constructor(options: ResilientHttpClientOptions) {
    this.name = options.name;
    this.internal = options.internal ?? false;
    this.clock = options.clock ?? new SystemClock();
    this.retry = {
      ...options.retry,
      backoff: options.retry?.backoff ?? DEFAULT_BACKOFF,
    };
    resolveMaxAttempts(this.retry); // a bad profile fails when the client is built, not on the first call
    this.dispatcher =
      options.dispatcher ??
      new Agent({
        keepAliveTimeout: IDLE_TIMEOUT_MS,
        keepAliveMaxTimeout: MAX_IDLE_TIMEOUT_MS,
        connections: 128,
        connect: { timeout: CONNECT_TIMEOUT_MS },
      });
    this.budget = new RetryBudget({
      clock: this.clock,
      onExhausted: () => exhaustedCounter().add(1, { dependency: this.name }),
    });
    this.bulkhead = new Bulkhead({
      ...DEFAULT_BULKHEAD,
      ...options.bulkhead,
      ...(options.maxConcurrent !== undefined && {
        maxConcurrent: options.maxConcurrent,
      }),
    });
    if (options.breaker !== false) {
      this.breaker = new CircuitBreaker({
        ...DEFAULT_BREAKER,
        ...options.breaker,
        name: this.name,
        clock: this.clock,
        isFailure: countsAsFailure,
      });
    }
  }

  static create(options: ResilientHttpClientOptions): ResilientHttpClient {
    return new ResilientHttpClient(options);
  }

  async requestJson<T>(
    url: string,
    options: HttpRequestOptions<T> = {},
  ): Promise<HttpResponse<T>> {
    // A call out while a transaction holds a connection is a bug (constitution III.3).
    assertNoActiveTransaction('network');
    const { method = 'GET', timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const maxAttempts = resolveMaxAttempts({
      ...this.retry,
      maxAttempts: options.maxAttempts ?? this.retry.maxAttempts,
    });
    const idempotent = options.idempotent ?? SAFE_METHODS.has(method);
    const ctx = currentContext();
    const target = new URL(url);
    const now = this.clock.nowMs();
    const deadline = Math.min(
      now + OVERALL_TIMEOUT_MS,
      options.deadlineAt ?? Infinity,
      ctx.deadlineAt ?? Infinity,
    );
    this.budget.recordRequest(target.host);

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.guarded(
          target,
          method,
          timeoutMs,
          deadline,
          ctx,
          options,
          attempt,
        );
        requests().add(1, { dependency: this.name, outcome: 'ok' });
        return response;
      } catch (caught) {
        const error = (
          caught instanceof CircuitOpenError
            ? new HttpClientError('circuit_open', {
                attempts: attempt,
                retryAfterMs: caught.retryAfterMs,
              })
            : caught
        ) as HttpClientError;
        const final = (e: HttpClientError) => {
          requests().add(1, { dependency: this.name, outcome: e.kind });
          return e.withAttempts(attempt + 1);
        };
        if (!(error instanceof HttpClientError)) throw error;
        const canRetry =
          idempotent &&
          error.retryable &&
          attempt + 1 < maxAttempts &&
          !options.signal?.aborted;
        if (!canRetry) throw final(error);

        const remaining = deadline - this.clock.nowMs();
        if (
          error.retryAfterMs !== undefined &&
          error.retryAfterMs > remaining
        ) {
          throw final(
            new HttpClientError('retry_after_exceeds_budget', {
              status: error.status,
              attempts: attempt + 1,
            }),
          );
        }
        const delay =
          error.retryAfterMs ?? fullJitterBackoff(attempt, this.retry.backoff);
        if (delay >= remaining || !this.budget.tryAcquireRetry(target.host))
          throw final(error);

        retriesCounter().add(1, { dependency: this.name });
        this.logger.warn(
          `[${this.name}] ${method} ${target.host} attempt ${attempt + 1} failed (${error.kind}${error.status ? ` ${error.status}` : ''}); retry in ${delay}ms`,
        );
        try {
          await sleep(delay, options.signal);
        } catch {
          throw final(
            new HttpClientError('aborted', { attempts: attempt + 1 }),
          );
        }
      }
    }
  }

  /** One attempt through the breaker and the bulkhead. */
  private async guarded<T>(
    target: URL,
    method: Dispatcher.HttpMethod,
    timeoutMs: number,
    deadline: number,
    ctx: Partial<AppClsStore>,
    options: HttpRequestOptions<T>,
    attempt: number,
  ): Promise<HttpResponse<T>> {
    const run = () =>
      this.bulkhead.run(() =>
        this.attemptOnce<T>(
          target,
          method,
          timeoutMs,
          deadline,
          ctx,
          options,
          attempt,
        ),
      );
    if (!this.breaker) return run();
    const fallback = options.fallback;
    const { value } = await this.breaker.execute(
      run,
      fallback && {
        fallback: async () => ({
          status: 200,
          headers: {},
          body: await fallback(),
          degraded: true,
        }),
      },
    );
    return value;
  }

  private async attemptOnce<T>(
    target: URL,
    method: Dispatcher.HttpMethod,
    timeoutMs: number,
    deadline: number,
    ctx: Partial<AppClsStore>,
    options: HttpRequestOptions<T>,
    attempt: number,
  ): Promise<HttpResponse<T>> {
    const remaining = deadline - this.clock.nowMs();
    if (remaining <= 0)
      throw new HttpClientError('timeout', { attempts: attempt + 1 });

    return trace
      .getTracer('http-client')
      .startActiveSpan(`${this.name} ${method}`, async (span) => {
        span.setAttribute('server.address', target.hostname);
        const headers: Record<string, string> = {
          accept: 'application/json',
          ...options.headers,
        };
        propagation.inject(context.active(), headers);
        if (ctx.traceparent && !headers.traceparent)
          headers.traceparent = ctx.traceparent;
        if (this.internal && ctx.requestId)
          headers['x-request-id'] = ctx.requestId;

        const timeout = AbortSignal.timeout(Math.min(timeoutMs, remaining));
        const signal = options.signal
          ? AbortSignal.any([timeout, options.signal])
          : timeout;
        const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
        try {
          const res = await request(target, {
            method,
            headers,
            body: options.body,
            dispatcher: this.dispatcher,
            signal,
          });
          const text = await this.readBody(res.body, maxBytes);
          span.setAttribute('http.status_code', res.statusCode);

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const retryAfterMs = parseRetryAfter(
              res.headers['retry-after'],
              this.clock.nowMs(),
            );
            throw new HttpClientError('status', {
              status: res.statusCode,
              attempts: attempt + 1,
              retryable: RETRYABLE_STATUS.has(res.statusCode),
              retryAfterMs,
            });
          }
          return {
            status: res.statusCode,
            headers: res.headers,
            body: this.parse<T>(text, res.headers['content-type'], attempt),
          };
        } catch (error) {
          const failure = this.classify(
            error,
            options.signal,
            timeout,
            attempt,
          );
          span.recordException(failure);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw failure;
        } finally {
          span.end();
        }
      });
  }

  /** Reads at most `maxBytes`; past that the connection is dropped, so memory stays bounded by the cap plus one chunk. */
  private async readBody(body: Readable, maxBytes: number): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) {
        body.destroy();
        throw new HttpClientError('response_too_large', { attempts: 0 });
      }
      chunks.push(chunk);
    }
    // undici hands the connection back one tick after the body ends; yielding here keeps a sequential next call on the
    // same connection instead of opening a second one.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return Buffer.concat(chunks).toString('utf8');
  }

  private parse<T>(
    text: string,
    contentType: string | string[] | undefined,
    attempt: number,
  ): T {
    if (!text) return undefined as T;
    const type = String(
      Array.isArray(contentType) ? contentType[0] : (contentType ?? ''),
    );
    if (!/(^|[/+])json\b/i.test(type))
      throw new HttpClientError('invalid_response', { attempts: attempt + 1 });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpClientError('invalid_response', { attempts: attempt + 1 });
    }
  }

  private classify(
    error: unknown,
    callerSignal: AbortSignal | undefined,
    timeout: AbortSignal,
    attempt: number,
  ): HttpClientError {
    if (error instanceof HttpClientError) return error;
    if (callerSignal?.aborted)
      return new HttpClientError('aborted', { attempts: attempt + 1 });
    if (timeout.aborted)
      return new HttpClientError('timeout', {
        attempts: attempt + 1,
        retryable: true,
      });
    // Resets, refusals, DNS failures and the like: transient for an idempotent call.
    return new HttpClientError('network_error', {
      attempts: attempt + 1,
      retryable: true,
    });
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; `undefined` when absent or unparseable, never negative. */
export function parseRetryAfter(
  value: string | string[] | undefined,
  nowMs: number,
): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
