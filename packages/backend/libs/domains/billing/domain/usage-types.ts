/**
 * Pure shapes of S18's usage flow (specs/domains/S18-usage-entitlements/data-model.md). Money is integer minor units,
 * quantities are safe integers, instants are `Date` in UTC; nothing here reads a clock or a store.
 */

/** A line of a renewal invoice that comes from usage. */
export interface UsageLine {
  kind: 'USAGE' | 'ADJUSTMENT';
  description: string;
  quantity: number;
  amountMinor: number;
}

/** What one `(period, metric)` moves from and to. `fromQuantity` binds `settle` to the state the plan was computed from. */
export interface SettlementEntry {
  metric: string;
  periodStart: Date;
  periodEnd: Date;
  fromQuantity: number;
  toQuantity: number;
  /** Snapshot of the period's terms: those of the price at first settlement, then the ledger row's own. */
  includedQuantity: number;
  overagePer1000Minor: number;
  /** True when the measurement is at or after `periodEnd + 91 days`: `settle` closes the row (FR-030). */
  final: boolean;
}

export interface SettlementPlan {
  entries: SettlementEntry[];
}

/** One stored settlement ledger row (table `UsageSettlement`). */
export interface SettlementRow {
  id: string;
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  metric: string;
  settledQuantity: number;
  settledAmountMinor: number;
  includedQuantity: number;
  overagePer1000Minor: number;
  lastInvoiceId: string;
  closed: boolean;
}

/** A validated usage record ready for the store. */
export interface UsageRecord {
  /** The envelope `eventId`, or `llm:<aggregateId>` for an LLM call. */
  identity: string;
  subjectId: string;
  metric: string;
  quantity: number;
  ts: Date;
}
