import { Injectable } from '@nestjs/common';
import { IngestFailure } from '../domain/failure-codes';
import type { PdfParser } from '../domain/ports';

/**
 * PDF text per page with `unpdf`. Every failure is an `IngestFailure` with a closed code: the parser's own message is
 * kept in `detail` for the worker and never reaches a response or a log line (S47 AS-24).
 */
@Injectable()
export class UnpdfParser implements PdfParser {
  async pages(bytes: Buffer, maxPages: number): Promise<string[]> {
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw new IngestFailure('not_a_pdf');
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      if (pdf.numPages > maxPages) throw new IngestFailure('too_many_pages');
      const { text } = await extractText(pdf, { mergePages: false });
      return text;
    } catch (error) {
      if (error instanceof IngestFailure) throw error;
      throw new IngestFailure('unparseable', (error as Error).message);
    }
  }
}
