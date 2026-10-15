import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `statements` (S16 FR-019, FR-042; S50 G-35): registered by `StatementsModule`.
 * `exports.concurrent` stays declared because other domains still borrow it until their call sites move (S50 may
 * delete it afterwards); statements itself uses only the `statements.*` names.
 */
export const statementsRatePolicies = definePolicies('statements', {
  'exports.concurrent': {
    algorithm: 'concurrency',
    limit: 2,
    windowMs: 10 * 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'statements.read': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'statements.export.concurrent': {
    algorithm: 'concurrency',
    limit: 2,
    windowMs: 10 * 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'statements.admin.read': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'statements.admin.write': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof statementsRatePolicies.policies
  > {}
}
