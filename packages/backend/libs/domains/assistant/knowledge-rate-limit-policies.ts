import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies of the knowledge half (S50 FR-050, S47 FR-038, FR-009): registered by `KnowledgeModule`.
 * `llm.messages` and `llm.provider.tpm` stay with S46 in `rate-limit-policies.ts`.
 */
export const knowledgeRatePolicies = definePolicies('assistant', {
  // Questions to the docs (anonymous buyers included) - each one is an embedding + a model call.
  'rag.ask': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  // Document creates and upload confirmations: every accepted one costs storage and an embedding pass.
  'rag.ingest': {
    algorithm: 'tokenBucket',
    limit: 30,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof knowledgeRatePolicies.policies
  > {}
}
