import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { settlementConflict } from '../domain/errors';
import { usageSettlementConflictsCounter } from '../domain/metrics';
import {
  SETTLEMENT_REPOSITORY,
  type SettlementPlan,
  type SettlementRepository,
} from '../domain/ports';
import { overageAmount } from '../domain/usage-overage';
import type { SettlementEntry, SettlementRow } from '../domain/usage-types';

/**
 * Records what an invoice billed for usage (S18 FR-028). Called by S17 inside the invoice-creating transaction (it
 * joins that transaction), with the plan `linesFor` returned, unchanged. Every entry is bound to the quantity it was
 * planned from: of two settlements built from the same state exactly one changes the row, the other is
 * `settlement_conflict` and the invoice transaction rolls back. A repeat with the same invoice id is a no-op.
 */
@Injectable()
export class UsageSettlementService {
  constructor(
    @Inject(SETTLEMENT_REPOSITORY)
    private readonly ledger: SettlementRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async settle(input: {
    invoiceId: string;
    subscriptionId: string;
    settlement: SettlementPlan;
  }): Promise<void> {
    for (const entry of input.settlement.entries)
      await this.apply(input.invoiceId, input.subscriptionId, entry);
  }

  private async apply(
    invoiceId: string,
    subscriptionId: string,
    entry: SettlementEntry,
  ): Promise<void> {
    const now = this.clock.now();
    const amount = overageAmount(
      entry.toQuantity,
      entry.includedQuantity,
      entry.overagePer1000Minor,
    );
    const row = await this.ledger.find(
      subscriptionId,
      entry.periodStart,
      entry.metric,
    );

    if (!row) {
      // only a first settlement can find no row; a plan from a later state is stale
      if (entry.fromQuantity !== 0) throw this.conflict();
      const inserted = await this.ledger.insertFirst(
        {
          subscriptionId,
          periodStart: entry.periodStart,
          periodEnd: entry.periodEnd,
          metric: entry.metric,
          settledQuantity: entry.toQuantity,
          settledAmountMinor: amount,
          includedQuantity: entry.includedQuantity,
          overagePer1000Minor: entry.overagePer1000Minor,
          lastInvoiceId: invoiceId,
          closed: entry.final,
        },
        now,
      );
      if (inserted) return;
      // someone inserted between the read and the insert: decide against what is there now
      const current = await this.ledger.find(
        subscriptionId,
        entry.periodStart,
        entry.metric,
      );
      if (current && this.alreadySettledBy(current, invoiceId, entry)) return;
      throw this.conflict();
    }

    if (this.alreadySettledBy(row, invoiceId, entry)) return;
    if (row.closed || row.settledQuantity !== entry.fromQuantity)
      throw this.conflict();
    // a first-settlement plan against a row that exists (settled at zero by another invoice) must carry its terms
    if (
      entry.fromQuantity === 0 &&
      (row.includedQuantity !== entry.includedQuantity ||
        row.overagePer1000Minor !== entry.overagePer1000Minor)
    )
      throw this.conflict();

    // the amount follows the row's own snapshot; the entry carries the same numbers
    const moved = await this.ledger.advance(
      subscriptionId,
      entry.periodStart,
      entry.metric,
      entry.fromQuantity,
      {
        quantity: entry.toQuantity,
        amountMinor: overageAmount(
          entry.toQuantity,
          row.includedQuantity,
          row.overagePer1000Minor,
        ),
        invoiceId,
        closed: entry.final,
      },
      now,
    );
    if (!moved) throw this.conflict();
  }

  /** This very invoice already moved the row to where the entry goes: a repeat (idempotent by invoice id). */
  private alreadySettledBy(
    row: SettlementRow,
    invoiceId: string,
    entry: SettlementEntry,
  ): boolean {
    return (
      row.lastInvoiceId === invoiceId &&
      row.settledQuantity === entry.toQuantity
    );
  }

  private conflict() {
    usageSettlementConflictsCounter.add(1);
    return settlementConflict();
  }
}
