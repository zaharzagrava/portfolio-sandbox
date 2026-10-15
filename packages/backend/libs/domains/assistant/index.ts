/**
 * Public entry point of the `assistant` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/assistant`.
 *
 * Knowledge half (S47, D-8): the three modules the apps import, the search service with its error and scope type, the
 * rate-limit policies, and the document DTO types (from `@marketplace-sandbox/contracts`). No repository, embedder,
 * parser, answer class or model is exported.
 *
 * Shopping assistant half (S46, still transitional): `AssistantModule`, `assistantRatePolicies`, `LlmCallsProjector`, and
 * thin aliases of the model-provider symbols that now live in `@app/infrastructure/llm` (D-14).
 */
export {
  KnowledgeModule,
  KnowledgeProjectorModule,
  KnowledgeSearchModule,
  KnowledgeWorkerModule,
} from './knowledge.module';
export { KnowledgeSearchService } from './application/knowledge-search.service';
export type {
  RetrievedChunk,
  SearchResult,
} from './application/knowledge-search.service';
export { RetrievalUnavailableError } from './domain/knowledge-errors';
// The evaluation harness (scripts/rag-eval) is the one consumer of the pure recall / MRR maths.
export { evaluateRetrieval } from './domain/retrieval-metrics';
export type { EvalReport } from './domain/retrieval-metrics';
export type { RetrievalScope } from './domain/scope';
export { knowledgeRatePolicies } from './knowledge-rate-limit-policies';

export { AssistantModule } from './assistant.module';
export { assistantRatePolicies } from './rate-limit-policies';
export { LlmCallsProjector } from './infra/llm-calls.projector';
// Thin aliases of the shared lib, kept until the shopping-half rewrite removes them (S46 T117); import the lib directly.
export {
  LLM_PROVIDER,
  LlmModule,
  LlmUnavailableError,
  ScriptedLlmProvider,
  textOf,
} from '@app/infrastructure/llm';
export type { LlmProvider, LlmTurnResult } from '@app/infrastructure/llm';
