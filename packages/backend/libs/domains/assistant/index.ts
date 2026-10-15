/**
 * Public entry point of the `assistant` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/assistant`.
 *
 * Knowledge half (S47, D-8): the three modules the apps import, the search service with its error and scope type, the
 * rate-limit policies, and the document DTO types (from `@marketplace-sandbox/contracts`). No repository, embedder,
 * parser, answer class or model is exported.
 *
 * Shopping assistant half (S46): `AssistantModule` (sse-gateway, core), `AssistantProjectorModule` (projector) and the
 * rate-limit policies. The model-provider port, adapters, price table and call recorder live in
 * `@app/infrastructure/llm` (D-14); the event `llm.call_completed` is defined there. No store, tool executor, model or
 * provider class is exported.
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
export { AssistantProjectorModule } from './assistant-projector.module';
