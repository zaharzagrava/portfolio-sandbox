import { costMicros, isPriced, UnknownModelError } from './pricing';

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

describe('model price table', () => {
  it.each([
    // model, usage, expected micro-dollars
    ['claude-opus-5-5', usage(1_000_000, 0, 0, 0), 4_000_000],
    ['claude-opus-5-5', usage(0, 1_000_000, 0, 0), 20_000_000],
    ['claude-opus-5-5', usage(0, 0, 1_000_000, 0), 200_000],
    ['claude-opus-5-5', usage(0, 0, 0, 1_000_000), 5_000_000],
    ['claude-sonnet-5-5', usage(1_000, 500, 0, 0), 7_000],
    ['claude-sonnet-5-5', usage(0, 0, 1_000_000, 0), 200_000],
    ['claude-haiku-4-5', usage(1_000_000, 1_000_000, 0, 0), 6_000_000],
    ['claude-haiku-4-5', usage(0, 0, 1_000_000, 0), 100_000],
    ['claude-haiku-4-5', usage(0, 0, 0, 1_000_000), 1_250_000],
    ['claude-opus-5-5', usage(0, 0, 0, 0), 0],
    ['claude-haiku-4-5', usage(0, 0, 0, 0), 0],
  ])('S46 AS-72: %s with %j costs %i micro-dollars', (model, u, expected) => {
    const cost = costMicros(model, u);
    expect(cost).toBe(expected);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('S46 AS-72: cache writes bill at 1.25 times the input price and the sum rounds to an integer', () => {
    // 1 token * $2/M * 1.25 = 2.5 micro-dollars -> 3
    expect(costMicros('claude-sonnet-5-5', usage(0, 0, 0, 1))).toBe(3);
  });

  it('S46 AS-74: a model missing from the price table is an error, never priced as another model', () => {
    expect(() => costMicros('claude-unknown-9', usage(1, 1, 1, 1))).toThrow(
      UnknownModelError,
    );
    expect(() => costMicros('claude-unknown-9', usage(1, 1, 1, 1))).toThrow(
      /claude-unknown-9/,
    );
  });

  it('S46 AS-74: isPriced tells the configured models from the unknown ones', () => {
    expect(isPriced('claude-opus-5-5')).toBe(true);
    expect(isPriced('claude-unknown-9')).toBe(false);
    expect(isPriced('')).toBe(false);
  });
});
