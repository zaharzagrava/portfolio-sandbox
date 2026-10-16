import type { ParsedItem, RowResult } from './import-row';

/** One record of the file: a row that passed the file rules, or one that failed them (it still counts as a record). */
export interface BatchRecord {
  /** 1-based ordinal: 1 is the first record after the header. */
  row: number;
  /** The byte where the next record starts. */
  byteEnd: number;
  sku: string;
  result: RowResult;
}

export interface CallItem {
  row: number;
  item: ParsedItem;
}

/**
 * A checkpoint window: records `(n-1)*size+1 .. n*size` (the last window of a file may be shorter). The catalog is
 * called once per entry of `calls` in order; a call never holds the same SKU twice, so the later row wins. One commit
 * (counters, `lastRow`, `nextByteOffset`) follows the whole window, so a window number is stable across resumes.
 */
export interface BatchWindow {
  batchNumber: number;
  records: BatchRecord[];
  calls: CallItem[][];
  lastRow: number;
  nextByteOffset: number;
}

export const IMPORT_BATCH_SIZE = 500;

export class ImportBatcher {
  private records: BatchRecord[] = [];

  /** `startRow` is the checkpoint's `lastRow` (a multiple of `size`, or 0). */
  constructor(
    private readonly size = IMPORT_BATCH_SIZE,
    private readonly startRow = 0,
  ) {
    if (!Number.isInteger(size) || size < 1 || size > IMPORT_BATCH_SIZE)
      throw new Error(`batch size must be 1..${IMPORT_BATCH_SIZE}`);
  }

  /** Adds the next record; returns the window when this record completes it. */
  add(record: BatchRecord): BatchWindow | null {
    this.records.push(record);
    return record.row % this.size === 0 ? this.take() : null;
  }

  /** The partial window at the end of the file, or `null` when nothing is pending. */
  flush(): BatchWindow | null {
    return this.records.length > 0 ? this.take() : null;
  }

  private take(): BatchWindow {
    const records = this.records;
    this.records = [];
    const calls: CallItem[][] = [];
    let current: CallItem[] = [];
    let skus = new Set<string>();
    for (const record of records) {
      if (!record.result.ok) continue;
      const sku = record.result.item.externalSku;
      if (skus.has(sku)) {
        calls.push(current);
        current = [];
        skus = new Set();
      }
      skus.add(sku);
      current.push({ row: record.row, item: record.result.item });
    }
    if (current.length > 0) calls.push(current);
    const last = records[records.length - 1];
    return {
      batchNumber: Math.ceil(last.row / this.size),
      records,
      calls,
      lastRow: last.row,
      nextByteOffset: last.byteEnd,
    };
  }

  /** Records waiting for the end of their window (a cancelled or interrupted run drops them). */
  get pending(): number {
    return this.records.length;
  }

  get windowStartRow(): number {
    return this.startRow;
  }
}
