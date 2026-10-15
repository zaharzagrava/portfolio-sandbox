import { FakeClock } from '@app/common/core/clock';
import type {
  ProviderAuth,
  ProviderLimiter,
  ProviderRatePolicy,
  SyncSession,
} from '../../domain/ports/commerce-provider.port';
import {
  InMemoryBreakerPersistence,
  InMemoryRefreshLock,
  ProviderHttp,
  type ProviderHttpOptions,
} from '../../infra/provider-http';
import type { FakeHttpServer } from './fake-http-server';

export interface FakeDecision {
  allowed: boolean;
  retryAfterMs: number | null;
  reason?:
    'limit-exceeded' | 'store-unavailable' | 'cost-exceeds-limit' | 'paused';
}

/** Limiter double: scripted decisions first, then a bucket paused by `penalize` (virtual time), then allow. */
export class FakeLimiter implements ProviderLimiter {
  readonly checks: { policy: string; subject: string }[] = [];
  readonly penalties: { policy: string; subject: string; ms: number }[] = [];
  scripted: (FakeDecision | Error)[] = [];
  pausedUntil = 0;

  constructor(private readonly clock: FakeClock) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- port contract is async
  async check(policy: ProviderRatePolicy, subject: string) {
    this.checks.push({ policy, subject });
    const next = this.scripted.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    const remaining = this.pausedUntil - this.clock.nowMs();
    if (remaining > 0)
      return {
        allowed: false,
        retryAfterMs: remaining,
        reason: 'paused' as const,
      };
    return { allowed: true, retryAfterMs: 0 };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- port contract is async
  async penalize(policy: ProviderRatePolicy, subject: string, ms: number) {
    this.penalties.push({ policy, subject, ms });
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.nowMs() + ms);
    return true;
  }
}

/** Auth double: a mutable token; `refresh` installs the fake provider's valid token. */
export class FakeAuth implements ProviderAuth {
  refreshCalls = 0;
  refreshDelayMs = 0;
  refreshResult = true;
  constructor(
    public token: string,
    private readonly header: (token: string) => Record<string, string>,
    private readonly validToken: string,
  ) {}
  // eslint-disable-next-line @typescript-eslint/require-await -- port contract is async
  async current() {
    return { headers: this.header(this.token), tokenId: this.token };
  }
  async refresh() {
    this.refreshCalls++;
    if (this.refreshDelayMs)
      await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    if (this.refreshResult) this.token = this.validToken;
    return this.refreshResult;
  }
}

export interface Harness {
  http: ProviderHttp;
  clock: FakeClock;
  limiter: FakeLimiter;
  breaker: InMemoryBreakerPersistence;
  lock: InMemoryRefreshLock;
  sleeps: number[];
  session(extra?: Partial<SyncSession>): SyncSession;
}

/** Test-only network option: plain HTTP to the fake on 127.0.0.1. Never used outside tests. */
export const testNetworkFor = () => ({
  allowHttpHosts: ['127.0.0.1'],
  allowPrivateHosts: ['127.0.0.1'],
});

/** A call stack pointed at a fake server with virtual time (`sleep` advances the clock instead of waiting). */
export function createHarness(
  fake: FakeHttpServer,
  options: Pick<ProviderHttpOptions, 'provider' | 'policy' | 'apiPath'> &
    Partial<ProviderHttpOptions>,
): Harness {
  const clock = new FakeClock(new Date('2026-03-01T12:00:00.000Z'));
  const limiter = new FakeLimiter(clock);
  const breaker = new InMemoryBreakerPersistence();
  const lock = new InMemoryRefreshLock();
  const sleeps: number[] = [];
  const http = new ProviderHttp({
    credentialId: 'cred-1',
    origin: fake.baseUrl,
    limiter,
    breaker,
    refreshLock: lock,
    clock,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
      // Virtual time, but yield real time so concurrent calls (single-flight refresh) can make progress.
      await new Promise((r) => setTimeout(r, 1));
    },
    unsafeTestNetwork: testNetworkFor(),
    ...options,
  });
  return {
    http,
    clock,
    limiter,
    breaker,
    lock,
    sleeps,
    session: (extra = {}) => ({
      call: http,
      integrationId: '11111111-1111-4111-8111-111111111111',
      normalise: {
        integrationId: '11111111-1111-4111-8111-111111111111',
        currency: 'USD',
        exponent: 2,
      },
      ...extra,
    }),
  };
}
