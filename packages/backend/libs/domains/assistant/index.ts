/**
 * Public entry point of the `assistant` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/assistant`.
 *
 * Knowledge half (S47, D-8): the three modules the apps import, the search service with its error and scope type, the
 * rate-limit policies, and the document DTO types (from `@marketplace-sandbox/contracts`). No repository, embedder,
 * parser, answer class or model is exported.
 *
 * Shopping assistant half (S46, still transitional): `AssistantModule`, `assistantRatePolicies`, and the model-provider
 * symbols other domains import today (`LlmMeter`, `LLM_PROVIDER`, `LlmUnavailableError`, `textOf`, `LlmModule`,
 * `ScriptedLlmProvider`, `LlmCallsProjector`). They move to `@app/infrastructure/llm` when S46 lands (debt D-14).
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
export { LlmMeter } from './infra/llm/llm-meter';
export {
  LLM_PROVIDER,
  LlmUnavailableError,
  textOf,
} from './infra/llm/llm-provider';
export type { LlmProvider, LlmTurnResult } from './infra/llm/llm-provider';
export { LlmModule } from './infra/llm/llm.module';
export { ScriptedLlmProvider } from './infra/llm/scripted.provider';
