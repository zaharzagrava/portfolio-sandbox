/**
 * Public entry point of the `assistant` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/assistant`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { AssistantModule } from './assistant.module';
export { assistantRatePolicies } from './rate-limit-policies';
export { KnowledgeModule, KnowledgeWorkerModule } from './knowledge.module';
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
export { Retriever } from './infra/retriever';
export type { RetrievalScope } from './infra/retriever';
