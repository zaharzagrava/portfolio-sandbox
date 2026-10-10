import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `statements` (S50 FR-050): registered by `StatementsModule`. */
export const statementsRatePolicies = definePolicies('statements', {
  'exports.concurrent': {
    algorithm: 'concurrency',
    limit: 2,
    windowMs: 10 * 60_000,
    key: 'shop',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof statementsRatePolicies.policies
  > {}
}
