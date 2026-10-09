import { Logger } from '@nestjs/common';
import { SystemClock } from '@app/common/core/clock';
import { CircuitBreaker, CircuitOpenError } from '@app/common/resilience';
import { DeliveryMessage, PermanentDeliveryError } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';

const SEND_TIMEOUT_MS = 10_000;

function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`provider send timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

export class AllProvidersFailedError extends Error {
  constructor(readonly causes: string[]) {
    super(`all providers failed: ${causes.join(' | ')}`);
  }
}

/**
 * Provider failover behind circuit breakers (lesson 06/03): SES down → SMTP,
 * without paying SES's timeout on every message while it's down (the breaker
 * is open → skipped instantly; half-open probes it again after 30 s).
 * Permanent errors are NOT failed over: a non-existent mailbox doesn't exist
 * at the second provider either.
 */
export class ChannelSender {
  private readonly logger = new Logger(ChannelSender.name);
  private readonly breakers: {
    provider: ChannelProvider;
    breaker: CircuitBreaker;
  }[];

  constructor(providers: ChannelProvider[]) {
    this.breakers = providers.map((provider) => ({
      provider,
      breaker: new CircuitBreaker({
        name: `notifications.${provider.name}`,
        clock: new SystemClock(),
        windowMs: 60_000,
        minimumCalls: 10,
        failureRateThreshold: 0.5,
        openDurationMs: 30_000,
        halfOpenCalls: 1,
        // Permanent rejections are the recipient's fault, not the provider's health.
        isFailure: (error) => !(error instanceof PermanentDeliveryError),
      }),
    }));
  }

  get providerNames(): string[] {
    return this.breakers.map((b) => b.provider.name);
  }

  async send(message: DeliveryMessage): Promise<SendResult> {
    const causes: string[] = [];
    for (const { provider, breaker } of this.breakers) {
      try {
        return (
          await breaker.execute(() =>
            withTimeout(provider.send(message), SEND_TIMEOUT_MS),
          )
        ).value;
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          this.logger.warn(`circuit open for ${provider.name}, skipped`);
          causes.push(`${provider.name}: circuit open`);
          continue;
        }
        if (error instanceof PermanentDeliveryError) throw error;
        causes.push(`${provider.name}: ${(error as Error).message}`);
      }
    }
    throw new AllProvidersFailedError(causes);
  }
}
