import { Inject, Injectable } from '@nestjs/common';
import { decodeCursor, encodeCursor } from '../domain/cursor';
import { invoiceNotFound } from '../domain/errors';
import { INVOICE_REPOSITORY, type InvoiceRepository } from '../domain/ports';
import type { InvoiceLineRow, InvoiceRow, Subject } from '../domain/types';

/**
 * Invoice reads for the owning subject (S17 FR-050, FR-051): keyset pages over every subscription of the subject
 * (also cancelled ones), newest first; a foreign or unknown id is the same `404` — the subject is in the predicate,
 * the invoice is never loaded by id and checked afterwards.
 */
@Injectable()
export class InvoiceQueryService {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
  ) {}

  async list(
    subject: Subject,
    limit: number,
    cursor?: string,
  ): Promise<{ items: InvoiceRow[]; nextCursor: string | null }> {
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const page = await this.invoices.list(subject, limit, after);
    return {
      items: page.items,
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }

  async detail(
    subject: Subject,
    invoiceId: string,
  ): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] }> {
    const invoice = await this.invoices.findForSubject(subject, invoiceId);
    if (!invoice) throw invoiceNotFound();
    return { invoice, lines: await this.invoices.lines(invoice.id) };
  }
}
