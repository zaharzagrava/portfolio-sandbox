import { Logger } from '@nestjs/common';
import type { Clock } from '@app/common/core/clock';
import {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitState,
} from '@app/common/resilience';
import {
  deliveryAttemptCounter,
  failoverCounter,
  providerCircuitGauge,
} from '../../domain/metrics';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';
import type { ProviderChain } from '../../domain/ports';
import { DeliveryMessage, PermanentDeliveryError } from '../../domain/types';

/** Every provider call is abandoned after this long (FR-029). */
export const SEND_TIMEOUT_MS = 10_000;

class ProviderTimeoutError extends Error {
  constructor(ms: number) {
    super(`provider send timed out after ${ms}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderTimeoutError(ms)), ms);
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

export class AllProvidersFailedError extends Error {
  constructor(readonly causes: string[]) {
    super(`all providers failed: ${causes.join(' | ')}`);
  }
}

/** 0 closed, 1 half-open, 2 open: the value of `notifications_provider_circuit_state`. */
const GAUGE_VALUE: Record<CircuitState, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

/**
 * One channel's ordered provider chain behind circuit breakers (FR-029, FR-030): a provider whose breaker is open is
 * skipped without a call, a transient failure or the 10 s timeout moves on to the next provider in the same attempt
 * (the result then carries `failover: true`), and a permanent rejection stops the walk, because a mailbox that does not
 * exist does not exist at the second provider either. Nothing here retries: the retry layer is the delivery line.
 */
export class ChannelSender implements ProviderChain {
  private readonly logger = new Logger(ChannelSender.name);
  private breakers: {
    provider: ChannelProvider;
    breaker: CircuitBreaker;
    state: CircuitState;
  }[] = [];

  constructor(
    private readonly providers: ChannelProvider[],
    private readonly clock: Clock,
  ) {
    this.reset();
  }

  /** Closes every breaker again (a fresh start; specs use it between scenarios). */
  reset(): void {
    this.breakers = this.providers.map((provider) => {
      providerCircuitGauge.set(0, { provider: provider.name });
      return {
        provider,
        state: 'CLOSED' as CircuitState,
        breaker: new CircuitBreaker({
          name: `notifications.${provider.name}`,
          clock: this.clock,
          windowMs: 60_000,
          minimumCalls: 10,
          failureRateThreshold: 0.5,
          openDurationMs: 30_000,
          halfOpenCalls: 1,
          // Permanent rejections are the recipient's fault, not the provider's health.
          isFailure: (error) => !(error instanceof PermanentDeliveryError),
        }),
      };
    });
  }

  get providerNames(): string[] {
    return this.breakers.map((b) => b.provider.name);
  }

  get primary(): string {
    return this.providers[0]?.name ?? 'none';
  }

  async send(message: DeliveryMessage): Promise<SendResult> {
    const causes: string[] = [];
    for (const entry of this.breakers) {
      const { provider, breaker } = entry;
      try {
        const { value } = await breaker.execute(() =>
          withTimeout(provider.send(message), SEND_TIMEOUT_MS),
        );
        this.observe(entry);
        deliveryAttemptCounter.add(1, {
          channel: message.channel,
          outcome: 'sent',
        });
        if (causes.length > 0)
          failoverCounter.add(1, { channel: message.channel });
        return causes.length > 0 ? { ...value, failover: true } : value;
      } catch (error) {
        this.observe(entry);
        if (error instanceof CircuitOpenError) {
          causes.push(`${provider.name}: circuit open`);
          continue;
        }
        if (error instanceof PermanentDeliveryError) {
          deliveryAttemptCounter.add(1, {
            channel: message.channel,
            outcome: 'permanent',
          });
          throw error;
        }
        deliveryAttemptCounter.add(1, {
          channel: message.channel,
          outcome:
            error instanceof ProviderTimeoutError ? 'timeout' : 'transient',
        });
        causes.push(`${provider.name}: ${(error as Error).message}`);
      }
    }
    throw new AllProvidersFailedError(causes);
  }

  /** Publishes the breaker's state and logs every transition (`open`, `half-open`, `closed`). */
  private observe(entry: {
    provider: ChannelProvider;
    breaker: CircuitBreaker;
    state: CircuitState;
  }): void {
    const state = entry.breaker.state();
    if (state === entry.state) return;
    entry.state = state;
    providerCircuitGauge.set(GAUGE_VALUE[state], {
      provider: entry.provider.name,
    });
    this.logger.warn(
      `notifications.provider.circuit provider=${entry.provider.name} state=${state.toLowerCase()}`,
    );
  }
}
