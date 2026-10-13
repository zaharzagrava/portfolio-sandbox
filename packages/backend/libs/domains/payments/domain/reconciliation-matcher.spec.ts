import * as fc from 'fast-check';
import {
  DuplicateTracker,
  type LedgerSide,
  type StatementLine,
  classifyLine,
  classifyMissingAtProvider,
  parseStatementLine,
  reconcile,
} from './reconciliation-matcher';

const line = (over: Partial<StatementLine> = {}): StatementLine => ({
  id: 'txn_1',
  type: 'charge',
  reference: 'pi_a',
  amountMinor: 100,
  currency: 'EUR',
  createdAt: new Date('2026-10-04T10:00:00Z'),
  ...over,
});
const side = (over: Partial<LedgerSide> = {}): LedgerSide => ({
  kind: 'SALE',
  reference: 'pi_a',
  amountMinor: 100,
  currency: 'EUR',
  ...over,
});

describe('Statement line validation', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    id: 'txn_1',
    type: 'charge',
    reference: 'pi_a',
    amount: 100,
    currency: 'eur',
    created: 1_759_572_000,
    ...over,
  });

  it('S14 AS-46: a well-formed charge becomes a line with an upper-case currency', () => {
    const r = parseStatementLine(raw(), 0);
    expect(r).toEqual({
      kind: 'line',
      line: {
        id: 'txn_1',
        type: 'charge',
        reference: 'pi_a',
        amountMinor: 100,
        currency: 'EUR',
        createdAt: new Date(1_759_572_000 * 1000),
      },
    });
  });

  it.each([
    ['payment', 'charge'],
    ['charge', 'charge'],
    ['refund', 'refund'],
    ['payment_refund', 'refund'],
    ['dispute', 'dispute'],
  ])('S14 AS-40: provider type %s is typed %s', (type, expected) => {
    const r = parseStatementLine(raw({ type, amount: -100 }), 3);
    expect(r.kind).toBe('line');
    if (r.kind === 'line') {
      expect(r.line.type).toBe(expected);
      expect(r.line.amountMinor).toBe(100);
    }
  });

  it.each([
    ['a missing id', { id: undefined }],
    ['an empty id', { id: '' }],
    ['a missing reference', { reference: undefined }],
    ['a non-integer amount', { amount: 12.5 }],
    ['a string amount', { amount: '100' }],
    ['an unsafe amount', { amount: 2 ** 53 }],
    ['an unknown currency code', { currency: 'euro' }],
    ['a numeric currency', { currency: 978 }],
    ['a missing currency', { currency: undefined }],
    ['a missing created time', { created: undefined }],
  ])(
    'S14 AS-46: %s is an invalid record reported by position only',
    (_n, over) => {
      expect(parseStatementLine(raw(over), 7)).toEqual({
        kind: 'invalid',
        position: 7,
      });
    },
  );

  it.each([null, undefined, 5, 'x', []])(
    'S14 AS-46: %j is not a record',
    (v) => {
      expect(parseStatementLine(v, 2)).toEqual({
        kind: 'invalid',
        position: 2,
      });
    },
  );

  it.each([
    ['adjustment_x', 'unknown'],
    ['transfer', 'transfer'],
    ['payout', 'transfer'],
  ])('S14 AS-46: type %s is skipped and counted under %s', (type, label) => {
    expect(parseStatementLine(raw({ type }), 1)).toEqual({
      kind: 'skipped',
      type: label,
    });
  });
});

describe('Matching a statement line to the ledger', () => {
  it('S14 AS-38: an exact match is matched', () => {
    expect(classifyLine(line(), side())).toEqual({ outcome: 'matched' });
  });

  it.each([
    [
      'no journal',
      line(),
      undefined,
      'MISSING_IN_LEDGER',
      { type: 'charge', providerAmount: 100, currency: 'EUR' },
    ],
    [
      'a refund we never made',
      line({ type: 'refund', reference: 're_x', amountMinor: 40 }),
      undefined,
      'MISSING_IN_LEDGER',
      { type: 'refund', providerAmount: 40, currency: 'EUR' },
    ],
    [
      'a dispute',
      line({ type: 'dispute', reference: 'dp_1', amountMinor: 2500 }),
      undefined,
      'MISSING_IN_LEDGER',
      { type: 'dispute', providerAmount: 2500, currency: 'EUR' },
    ],
    [
      'another amount',
      line({ amountMinor: 150 }),
      side(),
      'AMOUNT_MISMATCH',
      { type: 'charge', ledger: 100, provider: 150 },
    ],
    [
      'another currency',
      line({ currency: 'USD' }),
      side(),
      'CURRENCY_MISMATCH',
      { type: 'charge', ledger: 'EUR', provider: 'USD' },
    ],
    [
      'another currency and amount (currency first)',
      line({ currency: 'USD', amountMinor: 1 }),
      side(),
      'CURRENCY_MISMATCH',
      { type: 'charge', ledger: 'EUR', provider: 'USD' },
    ],
  ])('S14 AS-39: %s gives %s', (_n, l, s, kind, details) => {
    expect(classifyLine(l, s)).toEqual({
      outcome: 'issue',
      issue: { kind, reference: l.reference, details },
    });
  });

  it('S14 AS-40: a journal the provider does not list is MISSING_AT_PROVIDER', () => {
    expect(classifyMissingAtProvider(side({ reference: 'pi_b' }))).toEqual({
      kind: 'MISSING_AT_PROVIDER',
      reference: 'pi_b',
      details: { type: 'charge', ledgerAmount: 100, currency: 'EUR' },
    });
    expect(
      classifyMissingAtProvider(
        side({ kind: 'REFUND', reference: 're_1', amountMinor: 2500 }),
      ),
    ).toEqual({
      kind: 'MISSING_AT_PROVIDER',
      reference: 're_1',
      details: { type: 'refund', ledgerAmount: 2500, currency: 'EUR' },
    });
  });
});

describe('Duplicates at the provider', () => {
  it('S14 AS-40: a second charge line with the same reference is a duplicate; the same line twice is a repeat', () => {
    const t = new DuplicateTracker();
    expect(t.add(line({ id: 'txn_1' }))).toEqual({ result: 'new' });
    expect(t.add(line({ id: 'txn_1' }))).toEqual({ result: 'repeat' });
    expect(t.add(line({ id: 'txn_2' }))).toEqual({
      result: 'duplicate',
      issue: {
        kind: 'DUPLICATE_AT_PROVIDER',
        reference: 'pi_a',
        details: { type: 'charge', lineIds: ['txn_1', 'txn_2'] },
      },
    });
    // a third copy adds to the same issue reference but is still reported once per line id
    expect(t.add(line({ id: 'txn_3' }))).toEqual({
      result: 'duplicate',
      issue: {
        kind: 'DUPLICATE_AT_PROVIDER',
        reference: 'pi_a',
        details: { type: 'charge', lineIds: ['txn_1', 'txn_2', 'txn_3'] },
      },
    });
  });

  it('S14 AS-40: a charge and a refund may share a payment but not a reference', () => {
    const t = new DuplicateTracker();
    expect(t.add(line({ id: 'a', reference: 'pi_a' })).result).toBe('new');
    expect(
      t.add(line({ id: 'b', type: 'refund', reference: 're_a' })).result,
    ).toBe('new');
  });
});

describe('Whole-set reconciliation', () => {
  const ref = fc.integer({ min: 1, max: 40 }).map((n) => `pi_${n}`);
  const entry = fc.record({
    reference: ref,
    amountMinor: fc.integer({ min: 1, max: 100_000 }),
    currency: fc.constantFrom('EUR', 'USD'),
  });

  it('S14 AS-38: identical statements and ledgers give no issue (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(entry, { selector: (e) => e.reference, maxLength: 30 }),
        (entries) => {
          const lines = entries.map((e, i) => line({ id: `txn_${i}`, ...e }));
          const ledger = entries.map((e) => side({ ...e }));
          const r = reconcile(lines, ledger);
          return r.issues.length === 0 && r.matched === entries.length;
        },
      ),
    );
  });

  it('S14 AS-39: every seeded difference yields exactly one issue of the expected kind (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(entry, {
          selector: (e) => e.reference,
          minLength: 4,
          maxLength: 30,
        }),
        (entries) => {
          const lines = entries.map((e, i) => line({ id: `txn_${i}`, ...e }));
          const ledger = entries.map((e) => side({ ...e }));
          const [e0, e1, e2, e3] = entries;
          // four seeded differences on four distinct references
          const noJournal = ledger.filter((s) => s.reference !== e0.reference);
          const noLine = lines.filter((l) => l.reference !== e1.reference);
          const amount = noJournal.find((s) => s.reference === e2.reference)!;
          amount.amountMinor += 1;
          const currency = noJournal.find((s) => s.reference === e3.reference)!;
          currency.currency = currency.currency === 'EUR' ? 'USD' : 'EUR';
          const r = reconcile(noLine, noJournal);
          const got = new Map(r.issues.map((i) => [i.reference, i.kind]));
          return (
            r.issues.length === 4 &&
            got.get(e0.reference) === 'MISSING_IN_LEDGER' &&
            got.get(e1.reference) === 'MISSING_AT_PROVIDER' &&
            got.get(e2.reference) === 'AMOUNT_MISMATCH' &&
            got.get(e3.reference) === 'CURRENCY_MISMATCH' &&
            r.matched === entries.length - 4
          );
        },
      ),
    );
  });

  it('S14 AS-40: a journal without a statement line is MISSING_AT_PROVIDER and counted once', () => {
    const r = reconcile([], [side({ reference: 'pi_z' })]);
    expect(r.issues.map((i) => i.kind)).toEqual(['MISSING_AT_PROVIDER']);
    expect(r.matched).toBe(0);
  });
});
