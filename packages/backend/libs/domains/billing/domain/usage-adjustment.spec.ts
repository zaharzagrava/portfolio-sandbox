import fc from 'fast-check';
import { overageAmount } from './usage-overage';
import { planSettlement, type PlanInput } from './usage-adjustment';
import type { SettlementEntry, SettlementRow } from './usage-types';

const APRIL = {
  start: new Date('2026-04-01T00:00:00.000Z'),
  end: new Date('2026-05-01T00:00:00.000Z'),
};
const MAY = {
  start: new Date('2026-05-01T00:00:00.000Z'),
  end: new Date('2026-06-01T00:00:00.000Z'),
};
const STARTER = [
  { metric: 'api.calls', included: 10000, overagePer1000Minor: 50 },
];

const row = (over: Partial<SettlementRow> = {}): SettlementRow => ({
  id: 'r1',
  subscriptionId: 's1',
  periodStart: APRIL.start,
  periodEnd: APRIL.end,
  metric: 'api.calls',
  settledQuantity: 12500,
  settledAmountMinor: 150,
  includedQuantity: 10000,
  overagePer1000Minor: 50,
  lastInvoiceId: 'i1',
  closed: false,
  ...over,
});

const plan = (over: Partial<PlanInput> = {}) =>
  planSettlement({
    period: MAY,
    terms: STARTER,
    usedInPeriod: new Map([['api.calls', 0]]),
    openRows: [],
    measuredAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  });

describe('S18 settlement planning: usage lines of the period that ended', () => {
  it('S18 AS-32: 12,500 calls against 10,000 included bill 2,500 units for 150 and plan the move 0 -> 12,500', () => {
    const result = plan({
      period: APRIL,
      usedInPeriod: new Map([['api.calls', 12500]]),
      measuredAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    expect(result.lines).toEqual([
      {
        kind: 'USAGE',
        description: 'api.calls: 2500 units over 10000 included',
        quantity: 2500,
        amountMinor: 150,
      },
    ]);
    expect(result.settlement.entries).toEqual([
      {
        metric: 'api.calls',
        periodStart: APRIL.start,
        periodEnd: APRIL.end,
        fromQuantity: 0,
        toQuantity: 12500,
        includedQuantity: 10000,
        overagePer1000Minor: 50,
        final: false,
      },
    ]);
  });

  it.each([10000, 0])(
    'S18 AS-33: %p calls give no line and the plan still carries the entry',
    (used) => {
      const result = plan({
        period: APRIL,
        usedInPeriod: new Map([['api.calls', used]]),
      });
      expect(result.lines).toEqual([]);
      expect(result.settlement.entries).toHaveLength(1);
      expect(result.settlement.entries[0]).toMatchObject({
        fromQuantity: 0,
        toQuantity: used,
      });
    },
  );

  it('S18 AS-36: a price without included usage gives no lines and no entries', () => {
    expect(plan({ terms: [], usedInPeriod: new Map() })).toEqual({
      lines: [],
      settlement: { entries: [] },
    });
  });

  it('S18 AS-35: several metrics are ordered by metric, usage before adjustments, adjustments by period start', () => {
    const result = planSettlement({
      period: MAY,
      terms: [
        {
          metric: 'llm.assistant.tokens',
          included: 1000,
          overagePer1000Minor: 10,
        },
        { metric: 'api.calls', included: 10000, overagePer1000Minor: 50 },
      ],
      usedInPeriod: new Map([
        ['api.calls', 12500],
        ['llm.assistant.tokens', 3000],
      ]),
      openRows: [
        {
          row: row({
            id: 'r3',
            metric: 'llm.assistant.tokens',
            periodStart: APRIL.start,
            periodEnd: APRIL.end,
            settledQuantity: 1000,
            settledAmountMinor: 0,
            includedQuantity: 1000,
            overagePer1000Minor: 10,
          }),
          total: 2500,
        },
        {
          row: row({
            id: 'r2',
            periodStart: new Date('2026-03-01T00:00:00.000Z'),
            periodEnd: APRIL.start,
            settledQuantity: 10000,
            settledAmountMinor: 0,
          }),
          total: 11000,
        },
        { row: row({ id: 'r1' }), total: 13300 },
      ],
      measuredAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(result.lines.map((l) => [l.kind, l.description])).toEqual([
      ['USAGE', 'api.calls: 2500 units over 10000 included'],
      [
        'ADJUSTMENT',
        'api.calls: 1000 late overage units for 2026-03-01..2026-04-01',
      ],
      [
        'ADJUSTMENT',
        'api.calls: 800 late overage units for 2026-04-01..2026-05-01',
      ],
      ['USAGE', 'llm.assistant.tokens: 2000 units over 1000 included'],
      [
        'ADJUSTMENT',
        'llm.assistant.tokens: 1500 late overage units for 2026-04-01..2026-05-01',
      ],
    ]);
    expect(
      result.settlement.entries.map((e) => [
        e.metric,
        e.periodStart.toISOString().slice(0, 10),
      ]),
    ).toEqual([
      ['api.calls', '2026-03-01'],
      ['api.calls', '2026-04-01'],
      ['api.calls', '2026-05-01'],
      ['llm.assistant.tokens', '2026-04-01'],
      ['llm.assistant.tokens', '2026-05-01'],
    ]);
  });

  it('S18 AS-35: the same inputs always produce byte-identical lines', () => {
    const input: PlanInput = {
      period: MAY,
      terms: [
        { metric: 'llm.assistant.tokens', included: 0, overagePer1000Minor: 7 },
        { metric: 'api.calls', included: 10000, overagePer1000Minor: 50 },
      ],
      usedInPeriod: new Map([
        ['llm.assistant.tokens', 2500],
        ['api.calls', 12500],
      ]),
      openRows: [{ row: row(), total: 13300 }],
      measuredAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const first = JSON.stringify(planSettlement(input).lines);
    for (let i = 0; i < 5; i++)
      expect(
        JSON.stringify(
          planSettlement({ ...input, terms: [...input.terms].reverse() }).lines,
        ),
      ).toBe(first);
  });
});

describe('S18 settlement planning: late events become adjustments', () => {
  it('S18 AS-38: 800 late units on a period settled at 12,500 (150) become one adjustment of 50', () => {
    const result = plan({ openRows: [{ row: row(), total: 13300 }] });
    expect(result.lines).toContainEqual({
      kind: 'ADJUSTMENT',
      description:
        'api.calls: 800 late overage units for 2026-04-01..2026-05-01',
      quantity: 800,
      amountMinor: 50,
    });
    expect(result.settlement.entries[0]).toMatchObject({
      periodStart: APRIL.start,
      fromQuantity: 12500,
      toQuantity: 13300,
      includedQuantity: 10000,
      overagePer1000Minor: 50,
    });
  });

  it('S18 AS-38: once settled at 13,300 the next plan has no adjustment for April', () => {
    const result = plan({
      openRows: [
        {
          row: row({ settledQuantity: 13300, settledAmountMinor: 200 }),
          total: 13300,
        },
      ],
    });
    expect(result.lines).toEqual([]);
    expect(
      result.settlement.entries.filter(
        (e) => e.periodStart.getTime() === APRIL.start.getTime(),
      ),
    ).toEqual([]);
  });

  it.each([
    [9000, 1500, 500, 50],
    [9000, 500, 0, 0],
    [9000, 1000, 0, 0],
    [9000, 1001, 1, 50],
    [0, 20000, 10000, 500],
  ])(
    'S18 AS-39: settled at %p under the allowance, %p late events -> %p late overage units, amount %p',
    (settled, late, units, amount) => {
      const result = plan({
        openRows: [
          {
            row: row({ settledQuantity: settled, settledAmountMinor: 0 }),
            total: settled + late,
          },
        ],
      });
      const adjustment = result.lines.filter((l) => l.kind === 'ADJUSTMENT');
      if (amount === 0) expect(adjustment).toEqual([]);
      else
        expect(adjustment).toEqual([
          {
            kind: 'ADJUSTMENT',
            description: `api.calls: ${units} late overage units for 2026-04-01..2026-05-01`,
            quantity: units,
            amountMinor: amount,
          },
        ]);
      // the row moves forward whether or not there is a line, so the same units are not examined twice
      expect(result.settlement.entries[0]).toMatchObject({
        fromQuantity: settled,
        toQuantity: settled + late,
      });
    },
  );

  it('S18 AS-40: late events inside an already-billed block move the row without a line; the next block bills 50', () => {
    let current = row();
    const steps = [
      { total: 12700, line: null },
      { total: 13000, line: null },
      { total: 13001, line: { quantity: 1, amountMinor: 50 } },
    ];
    let billed = 150;
    for (const step of steps) {
      const result = plan({ openRows: [{ row: current, total: step.total }] });
      const adjustment = result.lines.find((l) => l.kind === 'ADJUSTMENT');
      if (step.line === null) expect(adjustment).toBeUndefined();
      else expect(adjustment).toMatchObject(step.line);
      billed += adjustment?.amountMinor ?? 0;
      const entry = result.settlement.entries[0];
      current = row({
        settledQuantity: entry.toQuantity,
        settledAmountMinor: overageAmount(entry.toQuantity, 10000, 50),
      });
    }
    expect(billed).toBe(200);
    expect(billed).toBe(overageAmount(13001, 10000, 50));
  });

  it('S18 AS-41: an adjustment uses the terms of the period, not the price of today', () => {
    const result = plan({
      terms: [
        { metric: 'api.calls', included: 10000, overagePer1000Minor: 60 },
      ],
      openRows: [{ row: row(), total: 13300 }],
    });
    expect(result.lines).toContainEqual(
      expect.objectContaining({ kind: 'ADJUSTMENT', amountMinor: 50 }),
    );
    expect(result.settlement.entries[0]).toMatchObject({
      overagePer1000Minor: 50,
      includedQuantity: 10000,
    });
  });

  it('S18 AS-41: the new period takes its snapshot from the price of today', () => {
    const result = plan({
      terms: [
        { metric: 'api.calls', included: 10000, overagePer1000Minor: 60 },
      ],
      usedInPeriod: new Map([['api.calls', 11000]]),
    });
    expect(result.lines[0]).toMatchObject({ kind: 'USAGE', amountMinor: 60 });
    expect(result.settlement.entries[0]).toMatchObject({
      overagePer1000Minor: 60,
    });
  });

  it('S18 AS-38: a row whose metric the price no longer includes is still adjusted from its own snapshot', () => {
    const result = plan({
      terms: [],
      usedInPeriod: new Map(),
      openRows: [{ row: row(), total: 13300 }],
    });
    expect(result.lines).toEqual([
      {
        kind: 'ADJUSTMENT',
        description:
          'api.calls: 800 late overage units for 2026-04-01..2026-05-01',
        quantity: 800,
        amountMinor: 50,
      },
    ]);
  });

  it('S18 AS-38: a total below what was settled is never turned into a negative line', () => {
    const result = plan({ openRows: [{ row: row(), total: 12000 }] });
    expect(result.lines).toEqual([]);
    expect(
      result.settlement.entries.filter(
        (e) => e.periodStart.getTime() === APRIL.start.getTime(),
      ),
    ).toEqual([]);
  });

  it('S18 AS-46: a measurement 91 days after the period end marks the entry final; 90 days does not', () => {
    const at = (iso: string) =>
      plan({
        openRows: [{ row: row(), total: 13300 }],
        measuredAt: new Date(iso),
      });
    // 2026-05-01 + 91 days = 2026-07-31
    expect(at('2026-07-30T23:59:59.999Z').settlement.entries[0].final).toBe(
      false,
    );
    expect(at('2026-07-31T00:00:00.000Z').settlement.entries[0].final).toBe(
      true,
    );
  });

  it('S18 AS-46: a row already settled to the exact total is still closed by a measurement after the window', () => {
    const result = plan({
      openRows: [
        {
          row: row({ settledQuantity: 13300, settledAmountMinor: 200 }),
          total: 13300,
        },
      ],
      measuredAt: new Date('2026-08-05T00:00:00.000Z'),
    });
    expect(result.lines).toEqual([]);
    expect(result.settlement.entries[0]).toMatchObject({
      periodStart: APRIL.start,
      fromQuantity: 13300,
      toQuantity: 13300,
      final: true,
    });
  });
});

describe('S18 settlement invariants (SC-002)', () => {
  /** An in-memory ledger that applies a plan the way `settle` does, so sequences of invoices can be generated. */
  function simulate(batches: number[], settleEvery: boolean[]) {
    let total = 0;
    let ledger: SettlementRow | null = null;
    let billed = 0;
    const terms = STARTER;
    let invoice = 0;
    for (let i = 0; i < batches.length; i++) {
      total += batches[i];
      if (!settleEvery[i]) continue;
      invoice++;
      const result = planSettlement({
        period: MAY,
        terms: ledger ? [] : terms,
        usedInPeriod: new Map(ledger ? [] : [['api.calls', total]]),
        openRows: ledger ? [{ row: ledger, total }] : [],
        measuredAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      for (const line of result.lines) billed += line.amountMinor;
      const entry: SettlementEntry | undefined = result.settlement.entries[0];
      if (entry)
        ledger = {
          id: 'x',
          subscriptionId: 's',
          periodStart: entry.periodStart,
          periodEnd: entry.periodEnd,
          metric: entry.metric,
          settledQuantity: entry.toQuantity,
          settledAmountMinor: overageAmount(
            entry.toQuantity,
            entry.includedQuantity,
            entry.overagePer1000Minor,
          ),
          includedQuantity: entry.includedQuantity,
          overagePer1000Minor: entry.overagePer1000Minor,
          lastInvoiceId: `i${invoice}`,
          closed: false,
        };
    }
    return { billed, ledger, total };
  }

  it('S18 AS-40: for any arrival pattern the sum of usage and adjustment amounts equals the price of the final total', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 8000 }), {
          minLength: 2,
          maxLength: 12,
        }),
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        (batches, flags) => {
          // the first measurement happens at the first batch, then after every flagged batch, and once at the end
          const settleEvery = batches.map(
            (_, i) => i === 0 || flags[i] || i === batches.length - 1,
          );
          const { billed, ledger, total } = simulate(batches, settleEvery);
          expect(ledger?.settledQuantity).toBe(total);
          expect(billed).toBe(overageAmount(total, 10000, 50));
          expect(ledger?.settledAmountMinor).toBe(billed);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
