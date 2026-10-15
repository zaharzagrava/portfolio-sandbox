import { overUnits, overageAmount } from './usage-overage';
import { isPeriodFinal } from './usage-period';
import type {
  SettlementEntry,
  SettlementPlan,
  SettlementRow,
  UsageLine,
} from './usage-types';

/** The terms of a metric in the subscriber's price today (the snapshot of a period that has no ledger row yet). */
export interface MetricTerms {
  metric: string;
  included: number;
  overagePer1000Minor: number;
}

export interface PlanInput {
  /** The period that just ended, `[start, end)`. */
  period: { start: Date; end: Date };
  terms: MetricTerms[];
  /** Exact total of the ended period per metric. */
  usedInPeriod: Map<string, number>;
  /** Open ledger rows with the exact current total of their period. */
  openRows: Array<{ row: SettlementRow; total: number }>;
  measuredAt: Date;
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The usage lines of one renewal and the settlement plan that records what they bill (S18 FR-024, FR-027, P0614).
 *
 * - Each metric the price includes yields the period's `USAGE` line (overage above the allowance, per started block of
 *   1,000 units) and a plan entry `0 -> used`, taken with the terms of today's price: that is the period's snapshot.
 * - Each open ledger row whose period gained units since it was settled yields an `ADJUSTMENT` for the increase in
 *   the overage amount, priced with the row's own snapshot, never today's price. When the amount did not change (the
 *   units fell inside an already-billed block, or under the allowance) there is no line and the entry still moves the
 *   row forward, so the same units are not examined twice.
 * - A measurement at or after `periodEnd + 91 days` marks the entry final: the row is closed and never queried again.
 *
 * Pure and deterministic: lines are ordered by metric, the metric's `USAGE` line first, then its adjustments by period
 * start; the same input always yields the same bytes.
 */
export function planSettlement(input: PlanInput): {
  lines: UsageLine[];
  settlement: SettlementPlan;
} {
  const byMetric = new Map<
    string,
    {
      usage?: UsageLine;
      entries: Array<{ entry: SettlementEntry; line?: UsageLine }>;
    }
  >();
  const bucket = (metric: string) => {
    let found = byMetric.get(metric);
    if (!found) byMetric.set(metric, (found = { entries: [] }));
    return found;
  };
  const rowOfPeriod = new Set(
    input.openRows.map(
      ({ row }) => `${row.metric}|${row.periodStart.toISOString()}`,
    ),
  );

  for (const terms of input.terms) {
    // a row for this very period already exists: it is handled below as an adjustment
    if (rowOfPeriod.has(`${terms.metric}|${input.period.start.toISOString()}`))
      continue;
    const used = input.usedInPeriod.get(terms.metric) ?? 0;
    const amount = overageAmount(
      used,
      terms.included,
      terms.overagePer1000Minor,
    );
    const slot = bucket(terms.metric);
    const units = overUnits(used, terms.included);
    if (amount > 0)
      slot.usage = {
        kind: 'USAGE',
        description: `${terms.metric}: ${units} units over ${terms.included} included`,
        quantity: units,
        amountMinor: amount,
      };
    slot.entries.push({
      entry: {
        metric: terms.metric,
        periodStart: input.period.start,
        periodEnd: input.period.end,
        fromQuantity: 0,
        toQuantity: used,
        includedQuantity: terms.included,
        overagePer1000Minor: terms.overagePer1000Minor,
        final: isPeriodFinal(input.period.end, input.measuredAt),
      },
    });
  }

  for (const { row, total } of input.openRows) {
    const final = isPeriodFinal(row.periodEnd, input.measuredAt);
    if (total <= row.settledQuantity && !final) continue;
    const to = Math.max(total, row.settledQuantity);
    const entry: SettlementEntry = {
      metric: row.metric,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      fromQuantity: row.settledQuantity,
      toQuantity: to,
      includedQuantity: row.includedQuantity,
      overagePer1000Minor: row.overagePer1000Minor,
      final,
    };
    const amount =
      overageAmount(to, row.includedQuantity, row.overagePer1000Minor) -
      row.settledAmountMinor;
    let line: UsageLine | undefined;
    if (amount > 0) {
      const units =
        overUnits(to, row.includedQuantity) -
        overUnits(row.settledQuantity, row.includedQuantity);
      line = {
        kind: 'ADJUSTMENT',
        description: `${row.metric}: ${units} late overage units for ${day(row.periodStart)}..${day(row.periodEnd)}`,
        quantity: units,
        amountMinor: amount,
      };
    }
    bucket(row.metric).entries.push({ entry, line });
  }

  const lines: UsageLine[] = [];
  const entries: SettlementEntry[] = [];
  for (const metric of [...byMetric.keys()].sort()) {
    const slot = byMetric.get(metric)!;
    if (slot.usage) lines.push(slot.usage);
    const ordered = slot.entries.sort(
      (a, b) => a.entry.periodStart.getTime() - b.entry.periodStart.getTime(),
    );
    for (const { entry, line } of ordered) {
      entries.push(entry);
      if (line) lines.push(line);
    }
  }
  return { lines, settlement: { entries } };
}
