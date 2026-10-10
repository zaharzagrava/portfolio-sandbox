import { ApiConfigService } from '@app/common/config';

/** The six `rate_limit_*` settings with their defaults (FR-055). */
export class RateLimitConfig {
  storeTimeoutMs = 200;
  breakerFailures = 3;
  breakerOpenMs = 2_000;
  fallbackInstances = 4;
  leaseTtlMs = 1_000;
  penaltyMaxMs = 3_600_000;

  static from(config: Pick<ApiConfigService, 'get'>): RateLimitConfig {
    const out = new RateLimitConfig();
    const read = (key: Parameters<ApiConfigService['get']>[0]): unknown =>
      config.get(key as never);
    const pick = (
      key:
        | 'rate_limit_store_timeout_ms'
        | 'rate_limit_breaker_failures'
        | 'rate_limit_breaker_open_ms'
        | 'rate_limit_fallback_instances'
        | 'rate_limit_lease_ttl_ms'
        | 'rate_limit_penalty_max_ms',
      fallback: number,
    ): number => {
      const value = read(key);
      return value === undefined || value === null ? fallback : Number(value);
    };
    out.storeTimeoutMs = pick('rate_limit_store_timeout_ms', 200);
    out.breakerFailures = pick('rate_limit_breaker_failures', 3);
    out.breakerOpenMs = pick('rate_limit_breaker_open_ms', 2_000);
    out.fallbackInstances = pick('rate_limit_fallback_instances', 4);
    out.leaseTtlMs = pick('rate_limit_lease_ttl_ms', 1_000);
    out.penaltyMaxMs = pick('rate_limit_penalty_max_ms', 3_600_000);
    out.validate();
    return out;
  }

  /** Fails startup, naming every bad key (VIII.5). */
  validate(): void {
    const bad = Object.entries({
      rate_limit_store_timeout_ms: this.storeTimeoutMs,
      rate_limit_breaker_failures: this.breakerFailures,
      rate_limit_breaker_open_ms: this.breakerOpenMs,
      rate_limit_fallback_instances: this.fallbackInstances,
      rate_limit_lease_ttl_ms: this.leaseTtlMs,
      rate_limit_penalty_max_ms: this.penaltyMaxMs,
    })
      .filter(([, v]) => !Number.isInteger(v) || v <= 0)
      .map(([k, v]) => `${k} must be a positive integer, got ${String(v)}`);
    if (bad.length)
      throw new Error(`Rate limiter configuration error: ${bad.join('; ')}`);
  }
}
