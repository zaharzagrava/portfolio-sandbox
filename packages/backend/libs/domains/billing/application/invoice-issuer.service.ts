import { Inject, Injectable } from '@nestjs/common';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { INVOICE_REPOSITORY, type InvoiceRepository } from '../domain/ports';
import type { InvoiceKind, InvoiceLineRow, InvoiceRow } from '../domain/types';
import './billing.job-types';

export const chargeJobKey = (invoiceId: string, attempt: number | string) =>
  `invoice-charge:${invoiceId}:${attempt}`;

/**
 * Creates an invoice with its lines and, when something is owed, the request to charge it, in the caller's
 * transaction (S17 FR-011, FR-023): the charge job can never run before the invoice commits, and a repeated trigger
 * finds the existing invoice by its business key instead of creating a second one. A total of zero or less is created
 * `PAID` and never charged (FR-037).
 */
@Injectable()
export class InvoiceIssuer {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    private readonly jobs: JobsService,
  ) {}

  async issue(input: {
    subscriptionId: string;
    kind: InvoiceKind;
    businessKey: string;
    periodStart: Date;
    periodEnd: Date;
    currency: string;
    lines: InvoiceLineRow[];
    usageMeasuredAt?: Date | null;
    now: Date;
  }): Promise<{ invoice: InvoiceRow; created: boolean }> {
    const totalMinor = input.lines.reduce((sum, l) => sum + l.amountMinor, 0);
    if (!Number.isSafeInteger(totalMinor))
      throw new Error('invoice total is outside the safe integer range');
    const result = await this.invoices.insertWithLines(
      {
        subscriptionId: input.subscriptionId,
        kind: input.kind,
        businessKey: input.businessKey,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: totalMinor > 0 ? 'OPEN' : 'PAID',
        totalMinor,
        currency: input.currency,
        usageMeasuredAt: input.usageMeasuredAt ?? null,
        now: input.now,
      },
      input.lines,
    );
    if (result.created && totalMinor > 0)
      await this.jobs.enqueue(
        'billing.charge-invoice',
        { invoiceId: result.invoice.id },
        { idempotencyKey: chargeJobKey(result.invoice.id, 1) },
      );
    return result;
  }
}
