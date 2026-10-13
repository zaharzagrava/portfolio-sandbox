import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Rate limit policies owned by `notifications` (S50 FR-050), registered through `RateLimitModule.forFeature` by
 * `NotificationsModule` (HTTP) and `NotificationsWorkerModule` (send budgets). `@RateLimit(...)` on a route is metadata
 * only: the global interceptor installed by `RateLimitModule.forRoot()` enforces it and answers `429` with
 * `Retry-After` and the structured `RateLimit` / `RateLimit-Policy` headers (`503 rate_limiter_unavailable` for a
 * fail-closed policy with the limiter down).
 */
export const notificationsRatePolicies = definePolicies('notifications', {
  // HTTP (contracts/http.md). Subject = the signed-in user, or the client address for the anonymous routes.
  'notifications.read.user': {
    algorithm: 'tokenBucket',
    limit: 120,
    windowMs: MINUTE,
    key: 'user',
    failMode: 'open',
  },
  'notifications.write.user': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: MINUTE,
    key: 'user',
    failMode: 'open',
  },
  // Cost control and abuse of SMS: 3 codes per hour per user, fail closed.
  'notifications.phone-code.user': {
    algorithm: 'slidingWindow',
    limit: 3,
    windowMs: HOUR,
    key: 'user',
    failMode: 'closed',
  },
  // Guessing a six-digit code: 5 wrong codes per 15 minutes per user, fail closed. A right code clears the count.
  'notifications.phone-verify.user': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: 15 * MINUTE,
    key: 'user',
    failMode: 'closed',
    count: 'failures-only',
    failureStatuses: [422],
    resetOnSuccess: true,
  },
  'notifications.unsubscribe.ip': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: MINUTE,
    key: 'ip',
    failMode: 'closed',
  },
  // Provider callbacks are signed; the limit only bounds a flood from one address. Fail open: never drop a complaint.
  'notifications.webhook.ip': {
    algorithm: 'tokenBucket',
    limit: 1_200,
    windowMs: MINUTE,
    key: 'ip',
    failMode: 'open',
  },

  // SD-17 provider send budgets (subject = provider, fleet-wide): SES default 14/s, Twilio ~10/s per number, FCM
  // generous. Transactional fails open (a limiter outage must not stop a password reset), marketing is 20 % of the
  // channel budget and fails closed (the worker delays it 60 s).
  'notify.email': {
    algorithm: 'tokenBucket',
    limit: 14,
    windowMs: 1_000,
    key: 'apiKey',
    failMode: 'open',
    localLeaseFraction: 0.2,
  },
  'notify.sms': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 1_000,
    key: 'apiKey',
    failMode: 'open',
  },
  'notify.push': {
    algorithm: 'tokenBucket',
    limit: 500,
    windowMs: 1_000,
    key: 'apiKey',
    failMode: 'open',
    localLeaseFraction: 0.1,
  },
  'notify.email.marketing': {
    algorithm: 'tokenBucket',
    limit: 3,
    windowMs: 1_000,
    key: 'apiKey',
    failMode: 'closed',
  },
  'notify.sms.marketing': {
    algorithm: 'tokenBucket',
    limit: 2,
    windowMs: 1_000,
    key: 'apiKey',
    failMode: 'closed',
  },
  'notify.push.marketing': {
    algorithm: 'tokenBucket',
    limit: 100,
    windowMs: 1_000,
    key: 'apiKey',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof notificationsRatePolicies.policies
  > {}
}
