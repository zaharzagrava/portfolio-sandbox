import { Logger } from '@nestjs/common';
import CircuitBreaker from 'opossum';
import { DeliveryMessage, PermanentDeliveryError } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';

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
  private readonly breakers: { provider: ChannelProvider; breaker: CircuitBreaker<[DeliveryMessage], SendResult> }[];

  constructor(providers: ChannelProvider[]) {
    this.breakers = providers.map((provider) => {
      const breaker = new CircuitBreaker((m: DeliveryMessage) => provider.send(m), {
        timeout: 10_000,
        errorThresholdPercentage: 50,
        volumeThreshold: 10,
        resetTimeout: 30_000,
        // Permanent rejections are the recipient's fault, not the provider's health.
        errorFilter: (error: Error) => error instanceof PermanentDeliveryError,
      });
      breaker.on('open', () => this.logger.warn(`circuit OPEN for ${provider.name}`));
      breaker.on('close', () => this.logger.log(`circuit closed for ${provider.name}`));
      return { provider, breaker };
    });
  }

  get providerNames(): string[] {
    return this.breakers.map((b) => b.provider.name);
  }

  async send(message: DeliveryMessage): Promise<SendResult> {
    const causes: string[] = [];
    for (const { provider, breaker } of this.breakers) {
      if (breaker.opened) {
        causes.push(`${provider.name}: circuit open`);
        continue;
      }
      try {
        return await breaker.fire(message);
      } catch (error) {
        if (error instanceof PermanentDeliveryError) throw error;
        causes.push(`${provider.name}: ${(error as Error).message}`);
      }
    }
    throw new AllProvidersFailedError(causes);
  }
}
