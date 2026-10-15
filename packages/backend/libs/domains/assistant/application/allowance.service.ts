import { Inject, Injectable } from '@nestjs/common';
import { EntitlementsService } from '@app/domains/billing';
import {
  ASSISTANT_CLOCK,
  QUOTA_COUNTER,
  type Clock,
  type QuotaCounter,
} from '../domain/assistant-ports';
import { monthKey, monthResetsAt, retryAfterSeconds } from '../domain/month';
import { Transient_AssistantUnavailable } from './assistant-errors';

export interface Allowance {
  used: number;
  limit: number;
  resetsAt: Date;
  /** Whole seconds until the month ends (the `Retry-After` of an exhausted allowance). */
  retryAfterSeconds: number;
}

/**
 * The shopper's monthly token allowance (S46 FR-025): the limit comes only from billing's entitlement and the month's
 * usage from the counter (seeded from billing when absent). Nothing readable means nothing admitted: there is no local
 * default plan.
 */
@Injectable()
export class AllowanceService {
  constructor(
    private readonly entitlements: EntitlementsService,
    @Inject(QUOTA_COUNTER) private readonly counter: QuotaCounter,
    @Inject(ASSISTANT_CLOCK) private readonly clock: Clock,
  ) {}

  async current(userId: string): Promise<Allowance> {
    let limit: number | undefined;
    try {
      limit = (await this.entitlements.get('USER', userId))
        .assistantTokensPerMonth;
    } catch {
      throw new Transient_AssistantUnavailable('entitlements_unavailable');
    }
    if (typeof limit !== 'number')
      throw new Transient_AssistantUnavailable('entitlements_unavailable');
    let used: number;
    try {
      used = await this.counter.used(userId, monthKey(this.clock));
    } catch {
      throw new Transient_AssistantUnavailable('entitlements_unavailable');
    }
    return {
      used,
      limit,
      resetsAt: monthResetsAt(this.clock),
      retryAfterSeconds: retryAfterSeconds(this.clock),
    };
  }
}
