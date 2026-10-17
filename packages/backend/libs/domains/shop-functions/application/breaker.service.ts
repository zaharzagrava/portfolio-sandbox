import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RequestContext } from '@app/infrastructure/context';
import type { Admission } from '../domain/breaker';
import { BREAKER_STORE, type BreakerStore } from '../domain/ports';
import { functionsLog } from './functions-log';
import { shopFunctionsMetrics } from './shop-functions.metrics';

/**
 * The circuit breaker of every function (S45 FR-030): state lives in Redis and is shared by all instances. The breaker
 * protects checkout, so it never becomes a new way to fail it: a store error admits the call (the 5 ms budget still
 * bounds it) and is logged.
 */
@Injectable()
export class BreakerService {
  private readonly logger = new Logger(BreakerService.name);

  constructor(
    @Inject(BREAKER_STORE) private readonly store: BreakerStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly context?: RequestContext,
  ) {}

  async admit(functionId: string): Promise<Admission> {
    try {
      return await this.store.admit(functionId, this.clock.nowMs());
    } catch {
      functionsLog(
        this.logger,
        this.context,
        'warn',
        'breaker_store_unavailable',
      );
      return 'ADMIT';
    }
  }

  async failure(functionId: string, reason: string): Promise<void> {
    try {
      const { opened } = await this.store.recordFailure(
        functionId,
        this.clock.nowMs(),
        reason,
      );
      if (opened) {
        shopFunctionsMetrics.breakerOpened();
        functionsLog(this.logger, this.context, 'warn', 'breaker_opened', {
          reason,
        });
      }
    } catch {
      functionsLog(
        this.logger,
        this.context,
        'warn',
        'breaker_store_unavailable',
      );
    }
  }

  async success(functionId: string): Promise<void> {
    try {
      await this.store.recordSuccess(functionId, this.clock.nowMs());
    } catch {
      functionsLog(
        this.logger,
        this.context,
        'warn',
        'breaker_store_unavailable',
      );
    }
  }
}
