import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { RateLimitPolicyName } from './rate-limit.types';
import { RateLimitInterceptor } from './rate-limit.interceptor';

export const RATE_LIMIT_METADATA = 'rate-limit:policies';

/**
 * `@RateLimit('auth.login.ip', 'auth.login.account')` - every listed policy
 * must allow the request. Implemented as an interceptor (not a guard) so it
 * runs after the auth guards and can key by the authenticated user/API key.
 */
export const RateLimit = (...policies: RateLimitPolicyName[]) =>
  applyDecorators(SetMetadata(RATE_LIMIT_METADATA, policies), UseInterceptors(RateLimitInterceptor));
