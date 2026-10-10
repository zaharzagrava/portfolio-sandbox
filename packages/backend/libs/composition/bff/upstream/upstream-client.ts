import { Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { SectionCode } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  HttpClientError,
  ResilientHttpClient,
} from '@app/infrastructure/http-client';
import { CurrentRequest } from '../request-id';
import { BffSettings } from '../bff-config';
import { ANONYMOUS_ID, Credentials, tokenOf } from '../credentials/credentials';
import { BreakerRegistry } from './breaker-registry';
import type { UpstreamBreaker } from './circuit-breaker';
import { ConcurrencyGate, RequestSlots } from './concurrency-gate';
import type { Capability, Endpoint } from './endpoints/endpoint';
import { sharedCacheTtlMs } from './shared-cache-policy';
import { cacheKey, ShapedCache } from './shaped-cache';
import { SingleFlight } from './single-flight';
import { classify, UpstreamFailure } from './upstream-error';

export interface CallContext {
  credentials: Credentials;
  /** Slots of the inbound request (per-request cap of in-flight calls). */
  slots: RequestSlots;
  /** Time this call may take: `min(own budget, time left)`. */
  budgetMs: number;
  /** The budget was cut by the overall deadline: a timeout then means `BUDGET_EXCEEDED`. */
  deadlineLimited?: boolean;
  signal?: AbortSignal;
}

export interface CallResult<T> {
  body: T;
  cache: 'hit' | 'miss' | 'coalesced' | 'bypass';
  durationMs: number;
}

/** Request headers the BFF may send upstream besides the ones it derives itself (contracts/http.md). */
const EXTRA_HEADERS = new Set(['x-forwarded-for', 'content-type']);

const callsTotal = () =>
  MetricsRegistry.counter({
    name: 'bff_upstream_calls_total',
    help: 'Upstream calls by capability, endpoint and outcome',
    labels: ['upstream', 'endpoint', 'outcome'],
  });
const callSeconds = () =>
  MetricsRegistry.histogram({
    name: 'bff_upstream_call_duration_seconds',
    help: 'Upstream call duration by capability and endpoint',
    labels: ['upstream', 'endpoint'],
    buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 2],
  });
const breakerState = () =>
  MetricsRegistry.gauge({
    name: 'bff_breaker_state',
    help: 'Breaker state per upstream: 0 closed, 1 half-open, 2 open',
    labels: ['upstream'],
  });

/**
 * The only code that reaches the domain APIs (S48 plan: upstream layer). It locks the origin to `bff_upstream_url`,
 * never follows redirects, attaches identity only when the endpoint declares it, sends only allow-listed headers,
 * validates every body with the endpoint's contract schema, classifies every failure into the closed code set, and
 * runs the per-upstream breaker, the bulkhead, the shared cache and request coalescing.
 */
@Injectable()
export class UpstreamClient {
  private readonly logger = new Logger(UpstreamClient.name);
  private readonly clients = new Map<Capability, ResilientHttpClient>();
  private readonly flights = new SingleFlight();
  readonly gate: ConcurrencyGate;

  constructor(
    private readonly settings: BffSettings,
    private readonly cache: ShapedCache,
    private readonly breakers: BreakerRegistry,
    private readonly request: CurrentRequest,
  ) {
    this.gate = new ConcurrencyGate(settings.gate);
  }

  breakerOf(upstream: Capability): UpstreamBreaker {
    return this.breakers.of(upstream);
  }

  /** Builds the absolute URL; anything that would leave the configured origin is refused (AS-63). */
  urlOf(endpoint: Endpoint<unknown>): URL {
    if (!endpoint.path.startsWith('/api/') || endpoint.path.includes('//'))
      throw new UpstreamFailure('UPSTREAM_UNAVAILABLE', false);
    const url = new URL(endpoint.path, this.settings.upstreamOrigin);
    if (url.origin !== this.settings.upstreamOrigin)
      throw new UpstreamFailure('UPSTREAM_UNAVAILABLE', false);
    for (const [k, v] of Object.entries(endpoint.query ?? {}))
      url.searchParams.set(k, v);
    return url;
  }

  private clientOf(upstream: Capability): ResilientHttpClient {
    let client = this.clients.get(upstream);
    if (!client) {
      client = ResilientHttpClient.create({
        name: `bff-${upstream}`,
        internal: true,
        breaker: false, // one breaker layer: ours (IV.6)
        maxConcurrent: this.settings.gate.perUpstream + 28,
        bulkhead: { maxQueue: 8, queueWaitMs: 50 },
      });
      this.clients.set(upstream, client);
    }
    return client;
  }

  private headersOf(
    endpoint: Endpoint<unknown>,
    credentials: Credentials,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = tokenOf(credentials);
    if (endpoint.identity !== 'none' && token)
      headers.authorization = `Bearer ${token}`;
    if (
      endpoint.anonymousId &&
      credentials.anonymousId &&
      ANONYMOUS_ID.test(credentials.anonymousId)
    )
      headers['x-anonymous-id'] = credentials.anonymousId;
    for (const [k, v] of Object.entries(endpoint.headers ?? {}))
      if (EXTRA_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
    return headers;
  }

  async call<T>(
    endpoint: Endpoint<T>,
    ctx: CallContext,
  ): Promise<CallResult<T>> {
    const started = performance.now();
    const url = this.urlOf(endpoint);
    const cacheable = endpoint.sharedCache && endpoint.identity === 'none';
    const key = cacheable ? cacheKey(endpoint.name, url.toString()) : undefined;

    try {
      if (Math.floor(ctx.budgetMs) <= 0)
        throw new UpstreamFailure('BUDGET_EXCEEDED', true);
      if (ctx.signal?.aborted)
        throw new UpstreamFailure('UPSTREAM_UNAVAILABLE', true, {
          aborted: true,
        });

      if (key) {
        const hit = await this.cache.get(key, endpoint.schema);
        if (hit !== undefined) {
          this.record(endpoint, 'cache_hit', started);
          return {
            body: hit,
            cache: 'hit',
            durationMs: performance.now() - started,
          };
        }
        const { value, coalesced } = await this.flights.run(
          key,
          ctx.signal,
          (flightSignal) => this.execute(endpoint, url, ctx, flightSignal, key),
        );
        this.record(endpoint, coalesced ? 'coalesced' : 'ok', started);
        return {
          body: value,
          cache: coalesced ? 'coalesced' : 'miss',
          durationMs: performance.now() - started,
        };
      }
      const body = await this.execute(endpoint, url, ctx, ctx.signal);
      this.record(endpoint, 'ok', started);
      return { body, cache: 'bypass', durationMs: performance.now() - started };
    } catch (error) {
      const failure = this.finalize(error, ctx);
      this.record(
        endpoint,
        failure.aborted ? 'aborted' : failure.code,
        started,
      );
      throw failure;
    }
  }

  /** The network call itself: gate → breaker → request → validate → cache. */
  private async execute<T>(
    endpoint: Endpoint<T>,
    url: URL,
    ctx: CallContext,
    signal: AbortSignal | undefined,
    cacheAs?: string,
  ): Promise<T> {
    const release = await this.gate.acquire(endpoint.upstream, ctx.slots);
    if (!release) throw new UpstreamFailure('UPSTREAM_OVERLOADED', true);
    const breaker = endpoint.breaker
      ? this.breakerOf(endpoint.upstream)
      : undefined;
    let admitted = false;
    try {
      if (breaker) {
        if (breaker.tryAcquire() === 'reject') {
          breakerState().set(2, { upstream: endpoint.upstream });
          throw new UpstreamFailure('CIRCUIT_OPEN', true);
        }
        admitted = true;
      }
      const response = await this.clientOf(
        endpoint.upstream,
      ).requestJson<unknown>(url.toString(), {
        method: endpoint.method,
        headers: this.headersOf(endpoint, ctx.credentials),
        body:
          endpoint.body === undefined
            ? undefined
            : JSON.stringify(endpoint.body),
        timeoutMs: Math.floor(ctx.budgetMs), // the timer API takes whole milliseconds
        maxAttempts: 1,
        signal,
      });
      const parsed = endpoint.schema.safeParse(response.body);
      if (!parsed.success) {
        this.logger.warn(
          `invalid upstream body endpoint=${endpoint.name} requestId=${this.request.requestId ?? '-'}`,
        );
        throw new UpstreamFailure('UPSTREAM_INVALID', false, {
          status: response.status,
        });
      }
      if (breaker) {
        breaker.onSuccess();
        admitted = false;
        breakerState().set(0, { upstream: endpoint.upstream });
      }
      if (cacheAs) {
        const header = response.headers['cache-control'];
        const ttl = sharedCacheTtlMs(
          Array.isArray(header) ? header.join(',') : header,
          this.settings.cacheCeilingMs,
        );
        if (ttl > 0) await this.cache.set(cacheAs, parsed.data, ttl);
      }
      return parsed.data;
    } catch (error) {
      const failure = this.finalize(error, ctx);
      if (breaker && admitted) {
        if (failure.countsAgainstUpstream) breaker.onFailure();
        else if (failure.aborted) breaker.onAbandoned();
        else breaker.onSuccess(); // an answer (404, 401) proves the upstream is alive
        breakerState().set(
          { closed: 0, 'half-open': 1, open: 2 }[breaker.state],
          { upstream: endpoint.upstream },
        );
      }
      throw failure;
    } finally {
      release();
    }
  }

  private finalize(error: unknown, ctx: CallContext): UpstreamFailure {
    if (error instanceof Error && error.name === 'AbortError')
      return new UpstreamFailure('UPSTREAM_UNAVAILABLE', true, {
        aborted: true,
      });
    const failure = classify(error);
    if (failure.code === 'UPSTREAM_TIMEOUT' && ctx.deadlineLimited)
      return new UpstreamFailure('BUDGET_EXCEEDED', true);
    if (error instanceof HttpClientError && error.kind === 'aborted')
      return new UpstreamFailure('UPSTREAM_UNAVAILABLE', true, {
        aborted: true,
      });
    return failure;
  }

  private record(
    endpoint: Endpoint<unknown>,
    outcome: SectionCode | 'ok' | 'cache_hit' | 'coalesced' | 'aborted',
    started: number,
  ): void {
    callsTotal().add(1, {
      upstream: endpoint.upstream,
      endpoint: endpoint.name,
      outcome,
    });
    callSeconds().record((performance.now() - started) / 1000, {
      upstream: endpoint.upstream,
      endpoint: endpoint.name,
    });
  }
}
