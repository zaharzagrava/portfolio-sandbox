import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { webhookMetrics } from '../application/webhook-metrics';
import {
  BreakerConfig,
  BreakerState,
  breakerStatus,
  CLOSED_BREAKER,
  onBreakerFailure,
} from '../domain/breaker';
import { BreakerStore } from '../domain/webhook-ports';
import {
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from './webhook-settings.provider';

const stateKey = (endpointId: string) => `wh:breaker:${endpointId}`;
const probeKey = (endpointId: string) => `wh:breaker:probe:${endpointId}`;
const STATE_TTL_SEC = 3 * 24 * 3600;

/**
 * Disposable breaker state per endpoint in the fast store (S43 R-07, FR-034). Never the source of truth: every store
 * error answers "closed" (delivery proceeds) and counts `webhook_breaker_degraded_total`, and no method throws (L-016:
 * the failure path must survive the failure).
 */
@Injectable()
export class RedisBreakerStore extends BreakerStore {
  private readonly logger = new Logger(RedisBreakerStore.name);
  private readonly config: BreakerConfig;

  constructor(
    private readonly redis: RedisService,
    @Inject(WEBHOOK_SETTINGS) settings: WebhookSettings,
  ) {
    super();
    this.config = {
      failureThreshold: settings.breakerFailureThreshold,
      baseOpenMs: settings.breakerBaseOpenMs,
      maxOpenMs: settings.breakerMaxOpenMs,
      probeWaitMs: settings.breakerProbeWaitMs,
    };
  }

  private degraded(error: unknown): void {
    webhookMetrics.breakerDegraded().add(1);
    this.logger.warn(
      `breaker store unavailable: ${(error as Error)?.message ?? 'error'}`,
    );
  }

  async get(endpointId: string): Promise<BreakerState> {
    try {
      const [raw, probe] = await Promise.all([
        this.redis.client.hgetall(stateKey(endpointId)),
        this.redis.client.exists(probeKey(endpointId)),
      ]);
      if (!raw || !raw.failures)
        return { ...CLOSED_BREAKER, probeInFlight: probe === 1 };
      return {
        consecutiveFailures: Number(raw.failures),
        openUntil: raw.openUntil ? Number(raw.openUntil) : null,
        probeInFlight: probe === 1,
      };
    } catch (error) {
      this.degraded(error);
      return { ...CLOSED_BREAKER };
    }
  }

  async isOpen(endpointId: string, nowMs: number): Promise<boolean> {
    return (
      breakerStatus(await this.get(endpointId), nowMs, this.config) !== 'closed'
    );
  }

  async acquireProbe(endpointId: string, leaseMs: number): Promise<boolean> {
    try {
      const won = await this.redis.client.set(
        probeKey(endpointId),
        '1',
        'PX',
        leaseMs,
        'NX',
      );
      return won === 'OK';
    } catch (error) {
      this.degraded(error);
      return true; // fail open: the delivery goes out as if closed
    }
  }

  async recordFailure(endpointId: string, now: number): Promise<BreakerState> {
    try {
      const failures = await this.redis.client.hincrby(
        stateKey(endpointId),
        'failures',
        1,
      );
      const next = onBreakerFailure(
        {
          consecutiveFailures: failures - 1,
          openUntil: null,
          probeInFlight: false,
        },
        now,
        this.config,
      );
      if (next.openUntil !== null)
        await this.redis.client.hset(
          stateKey(endpointId),
          'openUntil',
          String(next.openUntil),
        );
      await this.redis.client.expire(stateKey(endpointId), STATE_TTL_SEC);
      await this.redis.client.del(probeKey(endpointId));
      return next;
    } catch (error) {
      this.degraded(error);
      return { ...CLOSED_BREAKER };
    }
  }

  async recordSuccess(endpointId: string): Promise<void> {
    await this.reset(endpointId);
  }

  async reset(endpointId: string): Promise<void> {
    try {
      await this.redis.client.del(stateKey(endpointId), probeKey(endpointId));
    } catch (error) {
      this.degraded(error);
    }
  }
}
