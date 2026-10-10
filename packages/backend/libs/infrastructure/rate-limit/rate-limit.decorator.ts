import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { Request } from 'express';
import {
  RATE_LIMIT_EXEMPT_METADATA,
  RATE_LIMIT_METADATA,
} from './rate-limit.metadata';
import type { RateLimitPolicyName } from './rate-limit.types';

/** One policy on a route, with the per-route knobs (P0113: `policy` is a declared name, checked by the compiler). */
export interface RateLimitRouteOptions {
  policy: RateLimitPolicyName;
  /** Units this request costs; a pure function of the request. Normalized to `max(1, ceil(value))`, `1` if not finite. */
  cost?: (req: Request) => number;
  /** For policies keyed `custom`: the subject, or nothing (then the client address is used). */
  subject?: (req: Request) => string | null | undefined;
  /** For failures-only policies: statuses that keep the slot (default `401`, `403`). */
  failureStatuses?: readonly number[];
}

export type RateLimitArg = RateLimitPolicyName | RateLimitRouteOptions;

/** What the interceptor reads: every argument as an option object. */
export const normalizeRateLimitArgs = (
  args: readonly RateLimitArg[],
): RateLimitRouteOptions[] =>
  args.map((a) => (typeof a === 'string' ? { policy: a } : a));

/**
 * `@RateLimit('auth.login.ip', { policy: 'auth.login.account', cost: (req) => 2 })`: every listed policy must allow the
 * request, evaluated in declaration order. The global interceptor (`RateLimitModule.forRoot()`) applies it after the
 * guards, before the pipes and before any route-scoped interceptor such as the idempotency one (FR-025).
 */
export const RateLimit = (...args: RateLimitArg[]) =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_METADATA, normalizeRateLimitArgs(args)),
  );

/**
 * Takes a route (or controller) out of the default limit. The reason is required, logged at startup and reviewed
 * like any exemption: a blank reason fails startup (FR-049).
 */
export const RateLimitExempt = (reason: string) => {
  if (typeof reason !== 'string' || reason.trim() === '')
    throw new Error('@RateLimitExempt needs a non-blank reason');
  return SetMetadata(RATE_LIMIT_EXEMPT_METADATA, reason.trim());
};
