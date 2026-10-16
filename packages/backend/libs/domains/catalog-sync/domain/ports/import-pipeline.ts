import type { Readable } from 'node:stream';

export const IMPORT_PIPELINE = Symbol('IMPORT_PIPELINE');

/** One record of the file after tokenising, before the file rules (`parseRecord`) are applied. */
export type ParsedRecord =
  | { row: number; byteEnd: number; values: Record<string, unknown> }
  /** A JSON line over the record limit: one row error, parsing goes on at the next line. */
  | { row: number; byteEnd: number; oversize: true }
  /** A JSON line that is not an object. */
  | { row: number; byteEnd: number; invalid: true };

export interface ImportPipelineRun {
  source: Readable;
  format: 'csv' | 'jsonl';
  /** Byte where parsing starts: 0, or the checkpoint's `nextByteOffset`. */
  startOffset: number;
  /** The checkpoint's `lastRow`: the first record read is row `startRow + 1`. */
  startRow: number;
  /** The stored, normalised CSV header on a resume; `null` on a fresh run (the first record is the header). */
  header: string[] | null;
  /** Called once with the normalised CSV header, before any record; may throw to refuse the file. */
  onHeader: (columns: string[]) => void;
  /** Called once with the normalised keys of the first JSON object. */
  onKeys: (keys: string[]) => void;
  signal: AbortSignal;
  /** The batcher/writer: pulls records one at a time, so a slow write pauses the source. */
  consume: (records: AsyncIterable<ParsedRecord>) => Promise<void>;
}

/**
 * source -> parser -> consumer as one cancellable pipeline with backpressure (S07 D-06). An error in any stage, or the
 * abort signal, destroys every stage and the source before the promise settles.
 */
export interface ImportPipelinePort {
  run(options: ImportPipelineRun): Promise<void>;
}
