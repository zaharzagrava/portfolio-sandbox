import { Logger } from '@nestjs/common';
import { Agent, Dispatcher, request } from 'undici';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { RetryBudget } from './retry-budget';

export interface HttpRequestOptions {
  method?: Dispatcher.HttpMethod;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Total time for one attempt including body read. Every outbound call has one (lesson 06/03 §1). */
  timeoutMs?: number;
  /** Retries only happen when the caller declares the operation idempotent. */
  idempotent?: boolean;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
}

export class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Outbound HTTP for third-party APIs (Shopify sync, webhooks, crawler, LLM
 * providers): keep-alive connection pool, per-attempt timeouts, retries with
 * full-jitter backoff that honour Retry-After, a shared retry budget, and
 * W3C trace propagation.
 */
export class ResilientHttpClient {
  private readonly logger = new Logger(ResilientHttpClient.name);
  private readonly budget = new RetryBudget();

  constructor(
    private readonly name: string,
    private readonly dispatcher: Dispatcher = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 128,
      connect: { timeout: 5_000 },
    }),
  ) {}

  async requestJson<T>(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const { method = 'GET', timeoutMs = 10_000, idempotent = method === 'GET', maxRetries = 3 } = options;
    this.budget.recordRequest();

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt<T>(url, method, timeoutMs, options);
      } catch (error) {
        const err = error as HttpRequestError;
        const canRetry =
          idempotent && err.retryable && attempt < maxRetries && !options.signal?.aborted && this.budget.tryAcquireRetry();
        if (!canRetry) throw error;

        const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
        const delay = retryAfterMs ?? fullJitterBackoff(attempt, { baseMs: 100, maxMs: 5_000 });
        this.logger.warn(`[${this.name}] ${method} ${url} attempt ${attempt + 1} failed (${err.message}); retry in ${delay}ms`);
        await sleep(delay, options.signal);
      }
    }
  }

  private async attempt<T>(
    url: string,
    method: Dispatcher.HttpMethod,
    timeoutMs: number,
    options: HttpRequestOptions,
  ): Promise<HttpResponse<T>> {
    const tracer = trace.getTracer('http-client');
    return tracer.startActiveSpan(`${this.name} ${method}`, async (span) => {
      const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
      propagation.inject(context.active(), headers);

      const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];

      try {
        const res = await request(url, {
          method,
          headers,
          body: options.body,
          dispatcher: this.dispatcher,
          signal: AbortSignal.any(signals),
        });

        const text = await res.body.text();
        span.setAttribute('http.status_code', res.statusCode);

        if (res.statusCode >= 400) {
          const err = new HttpRequestError(`HTTP ${res.statusCode}`, res.statusCode, RETRYABLE_STATUS.has(res.statusCode));
          const retryAfter = parseRetryAfter(res.headers['retry-after']);
          if (retryAfter !== undefined) Object.assign(err, { retryAfterMs: retryAfter });
          throw err;
        }

        return {
          status: res.statusCode,
          headers: res.headers,
          body: (text ? JSON.parse(text) : undefined) as T,
        };
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof HttpRequestError) throw error;
        // Network errors and timeouts are retryable for idempotent calls.
        throw new HttpRequestError((error as Error).message, undefined, true);
      } finally {
        span.end();
      }
    });
  }
}

export function parseRetryAfter(value: string | string[] | undefined, now = Date.now()): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
