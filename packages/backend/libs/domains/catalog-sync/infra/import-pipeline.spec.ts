import { Readable } from 'node:stream';
import * as fc from 'fast-check';
import { ImportBatcher, type BatchRecord } from '../domain/import-batcher';
import { ImportFailureError } from '../domain/import-errors';
import {
  parseStage,
  type ParsedRecord,
  type ParseStageOptions,
} from './import-parse-stage';
import { runImportPipeline } from './import-pipeline';

const record = (row: number): BatchRecord => ({
  row,
  byteEnd: row * 10,
  sku: `S${row}`,
  result: {
    ok: true,
    item: {
      externalSku: `S${row}`,
      title: 't',
      category: 'c',
      brand: 'b',
      priceMinor: 100,
    },
  },
});

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

describe('S07 import pipeline: backpressure and abort', () => {
  it('S07 AS-43: a sink that never finishes its first batch lets at most 500 + 16 records be pulled', async () => {
    let pulled = 0;
    async function* generate() {
      for (let row = 1; row <= 1_000_000; row++) {
        pulled++;
        yield record(row);
      }
    }
    const source = Readable.from(generate(), { objectMode: true });
    const blocked = gate();
    const abort = new AbortController();
    const run = runImportPipeline<BatchRecord>({
      source,
      signal: abort.signal,
      consume: async (records, { signal }) => {
        const batcher = new ImportBatcher();
        const aborted = new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        );
        for await (const r of records) {
          if (batcher.add(r)) await Promise.race([blocked.promise, aborted]);
        }
      },
    });
    run.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pulled).toBeGreaterThanOrEqual(500);
    expect(pulled).toBeLessThanOrEqual(500 + 16);
    abort.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.destroyed).toBe(true);
  });

  it('S07 AS-43: when the sink resumes every record is delivered exactly once, in order', async () => {
    const total = 2300;
    const source = Readable.from(
      (function* () {
        for (let row = 1; row <= total; row++) yield record(row);
      })(),
      { objectMode: true },
    );
    const first = gate();
    const seen: number[] = [];
    const windows: number[] = [];
    const run = runImportPipeline<BatchRecord>({
      source,
      consume: async (records) => {
        const batcher = new ImportBatcher();
        const handle = async (w: { records: BatchRecord[] } | null) => {
          if (!w) return;
          if (windows.length === 0) await first.promise;
          windows.push(w.records.length);
          seen.push(...w.records.map((r) => r.row));
        };
        for await (const r of records) await handle(batcher.add(r));
        await handle(batcher.flush());
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(0);
    first.open();
    await run;
    expect(windows).toEqual([500, 500, 500, 500, 300]);
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it('S07 AS-42: an error in the consumer destroys the source and every stage', async () => {
    const source = Readable.from(
      (function* () {
        for (let row = 1; ; row++) yield record(row);
      })(),
      { objectMode: true },
    );
    const stages: Array<AsyncGenerator<BatchRecord>> = [];
    const stage = (input: AsyncIterable<BatchRecord>) => {
      const generator = (async function* () {
        for await (const r of input) yield r;
      })();
      stages.push(generator);
      return generator;
    };
    await expect(
      runImportPipeline<BatchRecord>({
        source,
        stages: [stage],
        consume: async (records) => {
          let n = 0;
          for await (const _ of records)
            if (++n === 700) throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(source.destroyed).toBe(true);
    // a finished generator returns { done: true }
    for (const g of stages)
      expect(await g.next()).toEqual({ done: true, value: undefined });
  });
});

const collect = async (
  data: Buffer,
  options: ParseStageOptions,
  chunk = 7,
): Promise<{ records: ParsedRecord[]; header: string[] | null }> => {
  const chunks: Buffer[] = [];
  for (let at = 0; at < data.length; at += chunk)
    chunks.push(data.subarray(at, at + chunk));
  let header: string[] | null = null;
  const records: ParsedRecord[] = [];
  await runImportPipeline<ParsedRecord>({
    source: Readable.from(chunks, { objectMode: false }),
    stages: [parseStage({ ...options, onHeader: (h) => (header = h) })],
    consume: async (all) => {
      for await (const r of all) records.push(r);
    },
  });
  return { records, header };
};

describe('S07 import parse stage', () => {
  const csv =
    '﻿ SKU ,Title,Price,Category,colour\r\n' +
    'A1,"Cable, braided",12.99,cables,red\r\n' +
    '\r\n' +
    'A2,Plain,"1,5",cables\r\n';

  it('S07 AS-14: the header is normalised and reported once, rows are numbered from 1, blank lines are skipped', async () => {
    const { records, header } = await collect(Buffer.from(csv), {
      format: 'csv',
      startOffset: 0,
      startRow: 0,
      header: null,
    });
    expect(header).toEqual(['sku', 'title', 'price', 'category', 'colour']);
    expect(records.map((r) => r.row)).toEqual([1, 2]);
    expect(records[0]).toMatchObject({
      values: {
        sku: 'A1',
        title: 'Cable, braided',
        price: '12.99',
        category: 'cables',
        colour: 'red',
      },
    });
    expect(records[1]).toMatchObject({
      values: { sku: 'A2', price: '1,5', colour: '' },
    });
  });

  it('S07 AS-34: a resumed stage given the stored header and byte offset yields the following rows with their ordinals', async () => {
    const data = Buffer.from(csv);
    const full = await collect(data, {
      format: 'csv',
      startOffset: 0,
      startRow: 0,
      header: null,
    });
    const first = full.records[0];
    const resumed = await collect(data.subarray(first.byteEnd), {
      format: 'csv',
      startOffset: first.byteEnd,
      startRow: 1,
      header: full.header,
    });
    expect(resumed.header).toBeNull();
    expect(resumed.records.map((r) => [r.row, r.byteEnd])).toEqual(
      full.records.slice(1).map((r) => [r.row, r.byteEnd]),
    );
  });

  it('S07 AS-34: resuming at every record end of a generated file yields the rest (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(
            fc.string({
              unit: fc.constantFrom(...'ab ,"\n€'.split('')),
              maxLength: 6,
            }),
            {
              minLength: 4,
              maxLength: 4,
            },
          ),
          { minLength: 1, maxLength: 8 },
        ),
        async (rows) => {
          const esc = (c: string) => `"${c.replace(/"/g, '""')}"`;
          const text =
            'sku,title,price,category\n' +
            rows.map((r) => r.map(esc).join(',')).join('\n') +
            '\n';
          const data = Buffer.from(text);
          const full = await collect(
            data,
            { format: 'csv', startOffset: 0, startRow: 0, header: null },
            5,
          );
          expect(full.records).toHaveLength(rows.length);
          for (const [i, r] of full.records.entries()) {
            const resumed = await collect(
              data.subarray(r.byteEnd),
              {
                format: 'csv',
                startOffset: r.byteEnd,
                startRow: r.row,
                header: full.header,
              },
              5,
            );
            expect(resumed.records.map((x) => [x.row, x.byteEnd])).toEqual(
              full.records.slice(i + 1).map((x) => [x.row, x.byteEnd]),
            );
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('S07 AS-14: JSON lines carry their keys, a BOM and blank lines are ignored', async () => {
    const data = Buffer.from(
      '﻿{"sku":"A","title":"T","price":19.99,"category":"c"}\n\n{"sku":"B","title":"U","price":"2","category":"c","colour":"x"}\n',
    );
    const { records, header } = await collect(data, {
      format: 'jsonl',
      startOffset: 0,
      startRow: 0,
      header: null,
    });
    expect(header).toBeNull();
    expect(records.map((r) => ('values' in r ? r.values.sku : null))).toEqual([
      'A',
      'B',
    ]);
    expect(records[0]).toMatchObject({ values: { price: 19.99 } });
  });

  it('S07 AS-28: an oversize JSON line is one marker row and the next lines still parse', async () => {
    const big = '{"sku":"' + 'a'.repeat(3000) + '"}';
    const data = Buffer.from(`{"sku":"A"}\n${big}\n{"sku":"B"}\n`);
    const { records } = await collect(
      data,
      {
        format: 'jsonl',
        startOffset: 0,
        startRow: 0,
        header: null,
        maxRecordBytes: 1000,
      },
      100,
    );
    expect(records.map((r) => ('values' in r ? r.values.sku : 'big'))).toEqual([
      'A',
      'big',
      'B',
    ]);
    expect(records.map((r) => r.row)).toEqual([1, 2, 3]);
  });

  it('S07 AS-28: a JSON line that is not an object is a marker row with a malformed flag', async () => {
    const data = Buffer.from('{"sku":"A"}\n[1,2]\nnot json\n');
    const { records } = await collect(data, {
      format: 'jsonl',
      startOffset: 0,
      startRow: 0,
      header: null,
    });
    expect(
      records.map((r) =>
        'values' in r ? 'ok' : 'invalid' in r ? 'invalid' : '?',
      ),
    ).toEqual(['ok', 'invalid', 'invalid']);
  });

  it('S07 AS-28: an oversize CSV record fails with malformed_file naming the row where it started', async () => {
    const data = Buffer.from('sku,title\nA,"' + 'x'.repeat(5000) + '\n');
    await expect(
      collect(
        data,
        {
          format: 'csv',
          startOffset: 0,
          startRow: 0,
          header: null,
          maxRecordBytes: 1000,
        },
        100,
      ),
    ).rejects.toMatchObject({ code: 'malformed_file', row: 1 });
  });

  it('S07 AS-42: a bare quote stops the stage with malformed_file and the ordinal of the broken row', async () => {
    const rows = Array.from({ length: 700 }, (_, i) => `S${i},T${i},1,c`);
    const data = Buffer.from(
      `sku,title,price,category\n${rows.join('\n')}\nBAD,ti"tle,1,c\nZ,Z,1,c\n`,
    );
    const error = await collect(
      data,
      { format: 'csv', startOffset: 0, startRow: 0, header: null },
      64,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ImportFailureError);
    expect(error).toMatchObject({ code: 'malformed_file', row: 701 });
  });

  it('S07 AS-16: the header callback can refuse the file before any record is produced', async () => {
    const records: unknown[] = [];
    const run = runImportPipeline<ParsedRecord>({
      source: Readable.from([Buffer.from('sku,title\nA,B\n')]),
      stages: [
        parseStage({
          format: 'csv',
          startOffset: 0,
          startRow: 0,
          header: null,
          onHeader: () => {
            throw new ImportFailureError('invalid_header', 'missing: price');
          },
        }),
      ],
      consume: async (all) => {
        for await (const r of all) records.push(r);
      },
    });
    await expect(run).rejects.toMatchObject({ code: 'invalid_header' });
    expect(records).toEqual([]);
  });
});
