/**
 * S50 AS-72: compile-time test, checked by `tsc --noEmit` (it is not run by jest).
 * An undeclared policy name must not compile in `@RateLimit(...)` or `check(...)`.
 */
import { RateLimit } from './rate-limit.decorator';
import type { RateLimiterService } from './rate-limiter.service';

declare const limiter: RateLimiterService;

// @ts-expect-error undeclared policy in the decorator
RateLimit('undeclared');
// @ts-expect-error undeclared policy in an option object
RateLimit({ policy: 'undeclared' });
// @ts-expect-error undeclared policy in code
void limiter.check('undeclared', 'user:1');

// declared names compile
RateLimit('default.read');
RateLimit({ policy: 'default.write', cost: () => 2 });
void limiter.check('default.read', 'user:1');
