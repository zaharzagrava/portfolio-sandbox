import * as fc from 'fast-check';
import {
  CALLER_KINDS,
  JOURNAL_KINDS,
  journalFingerprint,
  journalId,
  validateJournal,
} from './journal';
import { JournalInvalid, JournalUnbalanced } from './ledger-errors';

const SHOP = 'SHOP_0b9cf0b6-4a6f-4b8e-9d5c-6f0f3c2b9a11';

const base = (over: Record<string, unknown> = {}) => ({
  kind: 'ADJUSTMENT',
  reference: 't-1',
  currency: 'EUR',
  lines: [
    { accountId: 'PLATFORM_FEES', amountMinor: -1000 },
    { accountId: SHOP, amountMinor: 600 },
    { accountId: 'MARKETPLACE_CLEARING', amountMinor: 400 },
  ],
  ...over,
});

const reasonOf = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof JournalInvalid) return e.reason;
    if (e instanceof JournalUnbalanced) return 'journal_unbalanced';
    throw e;
  }
  return 'accepted';
};

const check = (input: unknown, fromCaller = true) =>
  reasonOf(() => validateJournal(input as never, { fromCaller }));

describe('Journal rules', () => {
  it('S14 AS-02: a balanced journal is accepted and an unbalanced one reports its sum', () => {
    expect(check(base())).toBe('accepted');
    const lines = [
      { accountId: 'PLATFORM_FEES', amountMinor: -1000 },
      { accountId: SHOP, amountMinor: 600 },
      { accountId: 'MARKETPLACE_CLEARING', amountMinor: 399 },
    ];
    try {
      validateJournal(base({ lines }) as never, { fromCaller: true });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(JournalUnbalanced);
      expect((e as JournalUnbalanced).sum).toBe(-1);
    }
  });

  it('S14 AS-02: any split of an amount sums to zero and is accepted (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (_total, parts) => {
          const sum = parts.reduce((a, b) => a + b, 0);
          const lines = [
            { accountId: 'PLATFORM_FEES', amountMinor: -sum },
            ...parts.map((p, i) => ({
              accountId: `SHOP_${'0'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
              amountMinor: p,
            })),
          ];
          return check(base({ lines })) === 'accepted';
        },
      ),
    );
  });

  it('S14 AS-02: perturbing any one line by a non-zero amount is refused as unbalanced (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 1, max: 1_000 }),
        (index, delta) => {
          const input = base();
          input.lines[index] = {
            ...input.lines[index],
            amountMinor: input.lines[index].amountMinor + delta,
          };
          // keep the line non-zero so only the sum rule can fire
          if (input.lines[index].amountMinor === 0) return true;
          return check(input) === 'journal_unbalanced';
        },
      ),
    );
  });

  it.each([
    [
      'one line',
      base({ lines: [{ accountId: 'PLATFORM_FEES', amountMinor: 5 }] }),
      'journal_too_few_lines',
    ],
    ['zero lines', base({ lines: [] }), 'journal_too_few_lines'],
    [
      'a line of 0',
      base({
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: 0 },
          { accountId: SHOP, amountMinor: 0 },
        ],
      }),
      'line_amount_zero',
    ],
    [
      'a line of 12.5',
      base({
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -12.5 },
          { accountId: SHOP, amountMinor: 12.5 },
        ],
      }),
      'line_amount_invalid',
    ],
    [
      'a line of 2^53',
      base({
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -(2 ** 53) },
          { accountId: SHOP, amountMinor: 2 ** 53 },
        ],
      }),
      'line_amount_invalid',
    ],
    [
      'a NaN line',
      base({
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: Number.NaN },
          { accountId: SHOP, amountMinor: 5 },
        ],
      }),
      'line_amount_invalid',
    ],
    [
      'two currencies in one journal',
      base({
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5, currency: 'EUR' },
          { accountId: SHOP, amountMinor: 5, currency: 'USD' },
        ],
      }),
      'journal_currency_mismatch',
    ],
    ['currency eur', base({ currency: 'eur' }), 'currency_invalid'],
    ['currency EURO', base({ currency: 'EURO' }), 'currency_invalid'],
    [
      'account SHOP_not-a-uuid',
      base({
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5 },
          { accountId: 'SHOP_not-a-uuid', amountMinor: 5 },
        ],
      }),
      'account_unknown',
    ],
    [
      'account FOO',
      base({
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5 },
          { accountId: 'FOO', amountMinor: 5 },
        ],
      }),
      'account_unknown',
    ],
    [
      'a shard suffix',
      base({
        lines: [
          { accountId: 'PLATFORM_FEES#07', amountMinor: -5 },
          { accountId: SHOP, amountMinor: 5 },
        ],
      }),
      'account_unknown',
    ],
    ['an empty reference', base({ reference: '' }), 'reference_invalid'],
    [
      'a reference of 201 characters',
      base({ reference: 'x'.repeat(201) }),
      'reference_invalid',
    ],
    [
      'a reference with a control character',
      base({ reference: 'a\nb' }),
      'reference_invalid',
    ],
    [
      'kind SALE through the caller API',
      base({ kind: 'SALE' }),
      'kind_not_allowed',
    ],
    ['an unknown kind', base({ kind: 'BONUS' }), 'kind_not_allowed'],
  ])('S14 AS-04: %s is refused with its own reason', (_name, input, reason) => {
    expect(check(input)).toBe(reason);
  });

  it.each([
    [1, 'journal_too_few_lines'],
    [2, 'accepted'],
    [200, 'accepted'],
    [201, 'journal_too_large'],
  ])('S14 AS-04: %i lines gives %s', (count, expected) => {
    const lines = Array.from({ length: count }, (_, i) => ({
      accountId: `SHOP_${'0'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
      amountMinor: 1,
    }));
    lines[0].amountMinor = -(count - 1);
    expect(check(base({ lines }))).toBe(expected);
  });

  it('S14 AS-04: the ledger itself may post SALE, REFUND, SETTLEMENT and SWEEP', () => {
    for (const kind of JOURNAL_KINDS)
      expect(check(base({ kind }), false)).toBe('accepted');
    expect([...CALLER_KINDS].sort()).toEqual(
      ['ADJUSTMENT', 'AD_CHARGE', 'PAYOUT', 'PAYOUT_REVERSAL'].sort(),
    );
  });

  it.each([
    [9_007_199_254_740_000, 'accepted'],
    [Number.MAX_SAFE_INTEGER, 'accepted'],
    [Number.MAX_SAFE_INTEGER + 1, 'line_amount_invalid'],
    [1.5, 'line_amount_invalid'],
  ])(
    'S14 AS-05: a line of %d at the safe-integer boundary gives %s',
    (amount, expected) => {
      const lines = [
        { accountId: 'PLATFORM_FEES', amountMinor: -amount },
        { accountId: SHOP, amountMinor: amount },
      ];
      expect(check(base({ lines }))).toBe(expected);
    },
  );

  it('S14 AS-07: the journal id is deterministic from (kind, reference) and distinct for distinct inputs', () => {
    expect(journalId('SALE', 'p-1')).toBe(journalId('SALE', 'p-1'));
    expect(journalId('SALE', 'p-1')).not.toBe(journalId('REFUND', 'p-1'));
    expect(journalId('SALE', 'p-1')).not.toBe(journalId('SALE', 'p-2'));
    expect(journalId('SALE', 'p-1')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...JOURNAL_KINDS),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        (kind, a, b) =>
          (a === b) === (journalId(kind, a) === journalId(kind, b)),
      ),
    );
  });

  it('S14 AS-07: the fingerprint ignores line order and changes with any amount, account, shard or currency', () => {
    const a = [
      { accountId: 'PLATFORM_FEES', shard: 3, amountMinor: -10 },
      { accountId: SHOP, shard: 0, amountMinor: 10 },
    ];
    const f = journalFingerprint('EUR', a);
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(journalFingerprint('EUR', [...a].reverse())).toBe(f);
    expect(journalFingerprint('USD', a)).not.toBe(f);
    expect(journalFingerprint('EUR', [{ ...a[0], shard: 4 }, a[1]])).not.toBe(
      f,
    );
    expect(
      journalFingerprint('EUR', [{ ...a[0], amountMinor: -11 }, a[1]]),
    ).not.toBe(f);
  });
});
