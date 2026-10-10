import { Injectable } from '@nestjs/common';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';

/**
 * The per-account second-factor budget (`auth.mfa.account`, R-07), shared by the four paths that compare a code:
 * login verify, confirm, regenerate and disable (plus the step-up of an explicit link). It is enforced from code, not
 * with `@RateLimit`, because the subject is known only after the challenge has been verified and one budget spans
 * several routes. A slot is taken immediately before a code is compared; a wrong code keeps it, a right one clears
 * the counter, and an attempt that was refused before any code was compared gives its slot back.
 */
@Injectable()
export class MfaAttemptBudget {
  constructor(private readonly limiter: RateLimiterService) {}

  /** Takes one slot or throws the standard 429 (with `Retry-After`) when the account is out of attempts. */
  async take(userId: string): Promise<void> {
    const decision = await this.limiter.check('auth.mfa.account', userId);
    if (decision.allowed) return;
    if (decision.reason === 'store-unavailable')
      throw new Domain_RateLimiterUnavailableError({
        'Cache-Control': 'no-store',
        'Retry-After': '1',
      });
    const seconds = Math.max(
      1,
      Math.ceil((decision.retryAfterMs ?? 1000) / 1000),
    );
    throw new Domain_RateLimitedError(seconds, {
      'Cache-Control': 'no-store',
      'Retry-After': String(seconds),
    });
  }

  /** A correct code: forget the failures. */
  succeeded(userId: string): Promise<void> {
    return this.limiter.reset('auth.mfa.account', userId);
  }

  /** The attempt said nothing about the code (state refused it, the store failed): it costs nothing. */
  refund(userId: string): Promise<void> {
    return this.limiter.refund('auth.mfa.account', userId);
  }
}
