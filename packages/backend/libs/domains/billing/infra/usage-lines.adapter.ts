import { Inject, Injectable } from '@nestjs/common';
import { UsageService } from '../application/usage.service';
import { overage } from '../domain/proration';
import {
  CATALOG_REPOSITORY,
  INVOICE_REPOSITORY,
  type CatalogRepository,
  type InvoiceRepository,
  type UsageInvoiceLinesProvider,
  type UsageLine,
} from '../domain/ports';

/** Rejects when `work` does not settle within `ms`; the timer never keeps the process alive. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('usage lines timed out')), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transitional `UsageInvoiceLinesProvider` over S18's `UsageService` (S17 research R-1, A25): until S18 ships its own,
 * the renewal asks for the usage lines through this token instead of reaching into the service. Overage for the period
 * that ended, plus the events of the period billed one invoice earlier that arrived after that invoice measured
 * (billed as an adjustment, never by editing a closed invoice). Throws on any failure or after `timeoutMs`.
 */
@Injectable()
export class UsageServiceLinesAdapter implements UsageInvoiceLinesProvider {
  constructor(
    private readonly usage: UsageService,
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
  ) {}

  linesFor(input: {
    subscriptionId: string;
    subjectId: string;
    priceId: string;
    periodStart: Date;
    periodEnd: Date;
    measuredAt: Date;
    timeoutMs: number;
  }): Promise<{ lines: UsageLine[] }> {
    return withTimeout(this.compute(input), input.timeoutMs);
  }

  private async compute(input: {
    subscriptionId: string;
    subjectId: string;
    priceId: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<{ lines: UsageLine[] }> {
    const price = await this.catalog.findPrice(input.priceId);
    if (!price) return { lines: [] };
    const previous = await this.invoices.previousRenewal(
      input.subscriptionId,
      input.periodEnd,
    );
    const billedBefore =
      previous?.usageMeasuredAt != null
        ? await this.invoices.previousRenewal(
            input.subscriptionId,
            previous.periodStart,
          )
        : null;
    const lines: UsageLine[] = [];
    for (const [metric, included] of Object.entries(price.includedUsage)) {
      const per1000 = price.overagePer1000Minor[metric] ?? 0;
      const used = await this.usage.totalFor(
        input.subjectId,
        metric,
        input.periodStart,
        input.periodEnd,
      );
      const over = overage(used, included, per1000);
      if (over.amount > 0)
        lines.push({
          kind: 'USAGE',
          description: `${metric} over ${included} (${over.units})`,
          quantity: over.units,
          amountMinor: over.amount,
        });
      if (previous?.usageMeasuredAt && billedBefore) {
        const late = await this.usage.lateFor(
          input.subjectId,
          metric,
          billedBefore.periodStart,
          billedBefore.periodEnd,
          previous.usageMeasuredAt,
        );
        if (late > 0)
          lines.push({
            kind: 'ADJUSTMENT',
            description: `${metric}: ${late} late events from previous period`,
            quantity: late,
            amountMinor: Math.ceil(late / 1000) * per1000,
          });
      }
    }
    return { lines };
  }
}
