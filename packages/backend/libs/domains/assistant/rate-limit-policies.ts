import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `assistant` (S50 FR-050): registered by `AssistantModule` and `KnowledgeModule`. */
export const assistantRatePolicies = definePolicies('assistant', {
  'llm.messages': {
    algorithm: 'tokenBucket',
    limit: 20,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  // SD-43: questions to the docs (anonymous buyers included) - each one is an embedding + a model call.
  'rag.ask': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  // SD-42: the provider's tokens-per-minute limit, shared by the whole fleet (subject = model). Taken with cost = estimated tokens.
  // Fail open: the store down must not take the assistant down; the provider's own 429 is the backstop.
  'llm.provider.tpm': {
    algorithm: 'tokenBucket',
    limit: 2_000_000,
    windowMs: 60_000,
    key: 'apiKey',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof assistantRatePolicies.policies
  > {}
}
