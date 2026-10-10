import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import type { RateLimitDecision } from './rate-limit.types';

const WINDOW_MS = 1_000;

/**
 * Denials are logged as structured lines, at most one per policy per second (a flood must not become a log flood,
 * AS-75). A line names the request, the policy, where the decision came from and why; never the subject, an address,
 * an e-mail, a token or anything of the request body.
 */
@Injectable()
export class RateLimitDenialLog {
  private readonly logger = new Logger('RateLimit');
  private readonly clock: Clock;
  private readonly last = new Map<string, { at: number; suppressed: number }>();

  constructor(@Optional() @Inject(CLOCK) clock?: Clock) {
    this.clock = clock ?? new SystemClock();
  }

  denied(
    policy: string,
    decision: RateLimitDecision,
    requestId: string | undefined,
  ): void {
    const now = this.clock.nowMs();
    const state = this.last.get(policy);
    if (state && now - state.at < WINDOW_MS) {
      state.suppressed++;
      return;
    }
    this.last.set(policy, { at: now, suppressed: 0 });
    this.logger.log({
      event: 'rate_limit_denied',
      requestId,
      policy,
      source: decision.source,
      reason: decision.reason,
      ...(state?.suppressed ? { suppressed: state.suppressed } : {}),
    });
  }
}
