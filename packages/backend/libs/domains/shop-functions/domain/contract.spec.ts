import {
  FunctionInput,
  FunctionOutput,
  OUTPUT_MAX_BYTES,
  TestCase,
  validateOutput,
  VerdictSchema,
} from './contract';

const input = {
  currency: 'EUR',
  lines: [
    { productId: 'p1', category: 'cases', quantity: 3, unitPriceMinor: 1200 },
  ],
};
const discount = {
  lineIndex: 0,
  type: 'fixedPerUnit',
  value: 200,
  message: 'ok',
};

describe('S45 AS-14 / FR-021: the function contract (strict)', () => {
  it('accepts the documented input and refuses unitPrice, a shop id and unknown keys', () => {
    expect(FunctionInput.safeParse(input).success).toBe(true);
    const old = {
      ...input,
      lines: [{ productId: 'p', category: 'c', quantity: 1, unitPrice: 5 }],
    };
    expect(FunctionInput.safeParse(old).success).toBe(false);
    expect(FunctionInput.safeParse({ ...input, shopId: 'S1' }).success).toBe(
      false,
    );
    expect(
      FunctionInput.safeParse({
        ...input,
        lines: [{ ...input.lines[0], shopId: 'S1' }],
      }).success,
    ).toBe(false);
  });

  it.each<[string, unknown]>([
    ['unknown type', { discounts: [{ ...discount, type: 'bogus' }] }],
    ['zero value', { discounts: [{ ...discount, value: 0 }] }],
    ['negative value', { discounts: [{ ...discount, value: -1 }] }],
    ['non-integer lineIndex', { discounts: [{ ...discount, lineIndex: 0.5 }] }],
    ['float fixedPerUnit', { discounts: [{ ...discount, value: 1.5 }] }],
    [
      'percentage with three decimals',
      { discounts: [{ ...discount, type: 'percentage', value: 10.123 }] },
    ],
    [
      'message over 80',
      { discounts: [{ ...discount, message: 'x'.repeat(81) }] },
    ],
    ['more than 50 discounts', { discounts: Array(51).fill(discount) }],
    ['unknown key', { discounts: [], extra: 1 }],
    ['not an object', 'discounts'],
  ])('refuses an output with %s', (_name, output) => {
    expect(FunctionOutput.safeParse(output).success).toBe(false);
  });

  it('accepts a percentage with two decimals', () => {
    expect(
      FunctionOutput.safeParse({
        discounts: [{ ...discount, type: 'percentage', value: 33.33 }],
      }).success,
    ).toBe(true);
  });

  it('validates lineIndex against the input and caps the serialised output', () => {
    expect(validateOutput(input, { discounts: [discount] })).toMatchObject({
      ok: true,
    });
    expect(
      validateOutput(input, { discounts: [{ ...discount, lineIndex: 1 }] }),
    ).toMatchObject({ ok: false });
    const big = JSON.stringify({
      discounts: [],
      pad: 'x'.repeat(OUTPUT_MAX_BYTES),
    });
    expect(validateOutput(input, JSON.parse(big), big.length)).toMatchObject({
      ok: false,
    });
  });

  it('parses test cases and verdicts strictly', () => {
    expect(
      TestCase.safeParse({
        name: 'a',
        input,
        expected: { discounts: [discount] },
      }).success,
    ).toBe(true);
    expect(
      TestCase.safeParse({ name: '', input, expected: { discounts: [] } })
        .success,
    ).toBe(false);
    for (const verdict of [
      'pass',
      'wrong-output',
      'timeout',
      'memory',
      'runtime',
      'invalid-output',
      'compile-error',
      'entry-missing',
    ])
      expect(
        VerdictSchema.safeParse({ case: 'a', verdict, ms: 1 }).success,
      ).toBe(true);
    expect(
      VerdictSchema.safeParse({ case: 'a', verdict: 'nope', ms: 1 }).success,
    ).toBe(false);
    expect(
      VerdictSchema.safeParse({
        case: 'a',
        verdict: 'runtime',
        detail: 'x'.repeat(301),
        ms: 1,
      }).success,
    ).toBe(false);
  });
});
