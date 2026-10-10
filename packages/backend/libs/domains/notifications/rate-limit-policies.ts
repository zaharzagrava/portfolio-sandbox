import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `notifications` (S50 FR-050): registered by `NotificationsWorkerModule`. */
export const notificationsRatePolicies = definePolicies('notifications', {
  // SD-17 provider send rates (subject = provider, fleet-wide): SES default 14/s, Twilio ~10/s per number, FCM generous.
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
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof notificationsRatePolicies.policies
  > {}
}
