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

/** A model with no price is a configuration error (AS-74): it is never priced as another model. */
export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`model "${model}" is not in the price table`);
    this.name = 'UnknownModelError';
  }
}

export const isPriced = (model: string): boolean =>
  Object.prototype.hasOwnProperty.call(PRICES, model);

/** Cost in micro-dollars (integer, like all money in this codebase). Throws `UnknownModelError` for an unpriced model. */
export function costMicros(model: string, usage: LlmUsage): number {
  if (!isPriced(model)) throw new UnknownModelError(model);
  const p = PRICES[model];
  // $ per million tokens x tokens = micro-dollars.
  return Math.round(
    usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.input * 1.25,
  );
}
