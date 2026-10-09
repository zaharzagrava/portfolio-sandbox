import type { LlmUsage } from './llm-provider';

/** USD per million tokens (input, output, cache read); cache writes (5-min TTL) bill at 1.25x input. */
const PRICES: Record<
  string,
  { input: number; output: number; cacheRead: number }
> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** Cost in micro-dollars (integer, like all money in this codebase). Unknown model → priced as the most expensive known one. */
export function costMicros(model: string, usage: LlmUsage): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5'];
  const usd =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.input * 1.25) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}

/** Tokens charged against the user's monthly allowance: cache reads at a tenth, like the provider bills them. */
export const quotaTokens = (u: LlmUsage) =>
  u.inputTokens +
  u.cacheWriteTokens +
  u.outputTokens +
  Math.ceil(u.cacheReadTokens / 10);

/** Cheap local estimate (~4 chars/token) - precise counting goes through the provider only near the compaction threshold. */
export const estimateTokens = (value: unknown) =>
  Math.ceil(JSON.stringify(value).length / 4);
