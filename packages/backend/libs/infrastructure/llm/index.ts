/**
 * `@app/infrastructure/llm`: the model-provider port, its Anthropic and scripted adapters, the pure token and price
 * arithmetic, the call recorder (outbox `llm.call_completed` v1) and the startup config check. Imports no domain code
 * and carries no assistant concept (S46 FR-041, AS-77).
 */
export { LlmModule, LLM_CONFIG } from './llm.module';
export {
  LLM_COOLDOWN_STORE,
  LLM_PROVIDER,
  LlmAbortedError,
  LlmRejectedError,
  LlmUnavailableError,
  textOf,
} from './llm-provider';
export type {
  CooldownStore,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStreamOptions,
  LlmTurnRequest,
  LlmTurnResult,
  LlmUsage,
} from './llm-provider';
export { AnthropicLlmProvider } from './anthropic.provider';
export type { AnthropicProviderOptions } from './anthropic.provider';
export { ScriptedLlmProvider } from './scripted.provider';
export type { ScriptedTurn } from './scripted.provider';
export { billableTokens, estimateTokens } from './billable-tokens';
export { costMicros, isPriced, UnknownModelError } from './pricing';
export { retryDelayMs } from './backoff';
export { LlmCallCompleted } from './llm-call-completed';
export { eventIdForCall, LlmCallRecorder } from './llm-call-recorder';
export type { LlmCallRecord } from './llm-call-recorder';
export {
  assertLlmConfig,
  llmConfigKeys,
  llmConfigViolations,
  LlmConfigError,
} from './llm-config';
export type { LlmConfig } from './llm-config';
