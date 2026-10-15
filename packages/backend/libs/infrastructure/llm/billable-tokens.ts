import type { LlmUsage } from './llm-provider';

/** Tokens charged against an allowance: cache reads at a tenth, like the provider bills them (AS-62). */
export const billableTokens = (u: LlmUsage): number =>
  u.inputTokens +
  u.cacheWriteTokens +
  u.outputTokens +
  Math.ceil(u.cacheReadTokens / 10);

/** Cheap local estimate (~4 characters per token); precise counting goes through the provider near thresholds only. */
export const estimateTokens = (characters: number): number =>
  Math.ceil(characters / 4);
