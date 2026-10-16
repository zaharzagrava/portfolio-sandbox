import {
  CsvSyntaxError,
  CsvTokenizer,
  RecordTooLargeError,
} from '../domain/import-csv';
import { ImportFailureError } from '../domain/import-errors';
import { JsonlSplitter } from '../domain/import-jsonl';
import { normaliseColumns, normaliseKeys } from '../domain/import-row';
import type { ParsedRecord } from '../domain/ports';

export type { ParsedRecord };

export interface ParseStageOptions {
  format: 'csv' | 'jsonl';
  /** Byte where parsing starts: 0, or the checkpoint's `nextByteOffset`. */
  startOffset: number;
  /** The checkpoint's `lastRow`: the first record read is row `startRow + 1`. */
  startRow: number;
  /** The stored, normalised CSV header on a resume; `null` on a fresh run (the first record is the header). */
  header: string[] | null;
  maxRecordBytes?: number;
  /** Called once with the normalised CSV header, before any record; may throw to refuse the file. */
  onHeader?: (columns: string[]) => void;
  /** Called once with the normalised keys of the first JSON object. */
  onKeys?: (keys: string[]) => void;
}

const isBlankCsv = (fields: string[]) =>
  fields.length === 1 && fields[0] === '';

/**
 * File bytes to records, lazily: the generator yields one record at a time, so nothing is tokenised ahead of the
 * consumer (S07 D-06). A broken CSV (bare quote, quote that never closes, record over the limit) ends the stream with
 * `malformed_file` and the ordinal of the record that broke.
 */
export function parseStage(
  options: ParseStageOptions,
): (source: AsyncIterable<Buffer>) => AsyncGenerator<ParsedRecord> {
  return async function* (source) {
    let row = options.startRow;
    let columns = options.header;
    let keysSeen = false;

    if (options.format === 'csv') {
      const tokenizer = new CsvTokenizer({
        startOffset: options.startOffset,
        maxRecordBytes: options.maxRecordBytes,
      });
      const handle = function* (
        records: ReturnType<CsvTokenizer['push']>,
      ): Generator<ParsedRecord> {
        for (const record of records) {
          if (isBlankCsv(record.fields)) continue;
          if (columns === null) {
            columns = normaliseColumns(record.fields);
            options.onHeader?.(columns);
            continue;
          }
          row++;
          const values: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i++)
            values[columns[i]] = record.fields[i] ?? '';
          yield { row, byteEnd: record.endOffset, values };
        }
      };
      // the records that preceded a break are still delivered, then the file fails at the record that broke
      const feed = function* (read: () => ReturnType<CsvTokenizer['push']>) {
        try {
          yield* handle(read());
        } catch (error) {
          if (
            error instanceof CsvSyntaxError ||
            error instanceof RecordTooLargeError
          ) {
            yield* handle(error.records);
            throw new ImportFailureError('malformed_file', undefined, row + 1);
          }
          throw error;
        }
      };
      for await (const chunk of source)
        yield* feed(() =>
          tokenizer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
      yield* feed(() => tokenizer.end());
      return;
    }

    const splitter = new JsonlSplitter({
      startOffset: options.startOffset,
      maxLineBytes: options.maxRecordBytes,
    });
    const handle = function* (
      lines: ReturnType<JsonlSplitter['push']>,
    ): Generator<ParsedRecord> {
      for (const line of lines) {
        row++;
        if (line.oversize || line.text === null) {
          yield { row, byteEnd: line.endOffset, oversize: true };
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line.text);
        } catch {
          yield { row, byteEnd: line.endOffset, invalid: true };
          continue;
        }
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          yield { row, byteEnd: line.endOffset, invalid: true };
          continue;
        }
        const values = normaliseKeys(parsed as Record<string, unknown>);
        if (!keysSeen) {
          keysSeen = true;
          options.onKeys?.(Object.keys(values));
        }
        yield { row, byteEnd: line.endOffset, values };
      }
    };
    for await (const chunk of source)
      yield* handle(
        splitter.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
    yield* handle(splitter.end());
  };
}
