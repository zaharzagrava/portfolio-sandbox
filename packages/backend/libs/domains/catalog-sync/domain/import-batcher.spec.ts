import {
  ImportBatcher,
  type BatchRecord,
  type BatchWindow,
} from './import-batcher';

const item = (sku: string, priceMinor = 100) => ({
  externalSku: sku,
  title: 't',
  category: 'c',
  brand: 'b',
  priceMinor,
});
const good = (row: number, sku = `S${row}`, price = 100): BatchRecord => ({
  row,
  byteEnd: row * 10,
  sku,
  result: { ok: true, item: item(sku, price) },
});
const bad = (row: number): BatchRecord => ({
  row,
  byteEnd: row * 10,
  sku: `S${row}`,
  result: {
    ok: false,
    problems: [{ field: 'title', code: 'missing_required' }],
  },
});

const feed = (batcher: ImportBatcher, records: BatchRecord[]) => {
  const windows: BatchWindow[] = [];
  for (const r of records) {
    const w = batcher.add(r);
    if (w) windows.push(w);
  }
  const rest = batcher.flush();
  if (rest) windows.push(rest);
  return windows;
};

describe('S07 import batcher', () => {
  it('S07 AS-13: 1,200 records make windows of 500, 500 and 200 records and calls of the same size', () => {
    const windows = feed(
      new ImportBatcher(),
      Array.from({ length: 1200 }, (_, i) => good(i + 1)),
    );
    expect(windows.map((w) => w.records.length)).toEqual([500, 500, 200]);
    expect(windows.map((w) => w.calls.map((c) => c.length))).toEqual([
      [500],
      [500],
      [200],
    ]);
    expect(windows.map((w) => w.batchNumber)).toEqual([1, 2, 3]);
    expect(windows.map((w) => w.lastRow)).toEqual([500, 1000, 1200]);
    expect(windows.map((w) => w.nextByteOffset)).toEqual([
      5000, 10_000, 12_000,
    ]);
  });

  it('S07 AS-19: a repeated SKU flushes the pending call first, so two calls never share a SKU', () => {
    const [w] = feed(new ImportBatcher(), [
      good(1, 'A1', 100),
      good(2),
      good(3),
      good(4),
      good(5),
      good(6),
      good(7, 'A1', 700),
    ]);
    expect(w.calls).toHaveLength(2);
    expect(w.calls[0].map((c) => c.row)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(w.calls[1].map((c) => c.row)).toEqual([7]);
    // later row wins: the call that carries row 7 is sent after the call that carries row 2... in file order
    expect(w.calls[1][0].item.priceMinor).toBe(700);
    for (const call of w.calls) {
      const skus = call.map((c) => c.item.externalSku);
      expect(new Set(skus).size).toBe(skus.length);
    }
  });

  it('S07 AS-19: a SKU that repeats three times makes three calls in file order', () => {
    const [w] = feed(new ImportBatcher(), [
      good(1, 'X'),
      good(2, 'X'),
      good(3, 'X'),
    ]);
    expect(w.calls.map((c) => c.map((x) => x.row))).toEqual([[1], [2], [3]]);
  });

  it('S07 AS-19: the window still ends at the 500th record whatever the calls', () => {
    const records = Array.from({ length: 600 }, (_, i) =>
      good(i + 1, i % 2 ? 'ODD' : 'EVEN'),
    );
    const windows = feed(new ImportBatcher(), records);
    expect(windows.map((w) => w.records.length)).toEqual([500, 100]);
    expect(windows.map((w) => w.batchNumber)).toEqual([1, 2]);
  });

  it('S07 AS-19: a file-rule failure counts as a record but travels in no call', () => {
    const [w] = feed(new ImportBatcher(), [good(1), bad(2), good(3)]);
    expect(w.records).toHaveLength(3);
    expect(w.calls.flat().map((c) => c.row)).toEqual([1, 3]);
    expect(w.lastRow).toBe(3);
  });

  it('S07 AS-19: a window of failures only has no call', () => {
    const [w] = feed(new ImportBatcher(), [bad(1), bad(2)]);
    expect(w.calls).toEqual([]);
    expect(w.records).toHaveLength(2);
  });

  it.each([
    [1, 1],
    [499, 1],
    [500, 1],
    [501, 2],
    [1000, 2],
    [1001, 3],
  ])(
    'S07 AS-19: lastRow %i is in batch %i (ceil(lastRow / 500))',
    (lastRow, batch) => {
      const b = new ImportBatcher(500, lastRow - ((lastRow - 1) % 500) - 1);
      let w: BatchWindow | null = null;
      for (let row = lastRow - ((lastRow - 1) % 500); row <= lastRow; row++) {
        w = b.add(good(row)) ?? w;
      }
      w = b.flush() ?? w;
      expect(w!.batchNumber).toBe(batch);
    },
  );

  it('S07 AS-34: a resumed batcher continues the window numbering from the checkpoint', () => {
    const b = new ImportBatcher(500, 1500);
    const windows = feed(
      b,
      Array.from({ length: 1500 }, (_, i) => good(1501 + i)),
    );
    expect(windows.map((w) => w.batchNumber)).toEqual([4, 5, 6]);
  });

  it('S07 AS-19: nothing pending flushes to null, and a size outside 1..500 is refused', () => {
    expect(new ImportBatcher().flush()).toBeNull();
    expect(() => new ImportBatcher(0)).toThrow();
    expect(() => new ImportBatcher(501)).toThrow();
  });
});
