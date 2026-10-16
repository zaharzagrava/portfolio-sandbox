import * as fc from 'fast-check';
import { parse } from 'csv-parse/sync';
import {
  CsvSyntaxError,
  CsvTokenizer,
  RecordTooLargeError,
  type CsvRecord,
} from './import-csv';
import { JsonlSplitter, type JsonlLine } from './import-jsonl';

const tokenise = (data: Buffer, chunkSizes: number[] = [data.length || 1]) => {
  const t = new CsvTokenizer();
  const out: CsvRecord[] = [];
  let at = 0;
  let i = 0;
  while (at < data.length) {
    const size = chunkSizes[i++ % chunkSizes.length];
    out.push(...t.push(data.subarray(at, at + size)));
    at += size;
  }
  out.push(...t.end());
  return out;
};

const cell = fc.string({
  unit: fc.constantFrom(...Array.from('ab ,"\n\r\t€é😀-=_xy')),
  maxLength: 12,
});

const serialise = (rows: string[][], eol: string) =>
  rows
    .map((r) =>
      r
        .map((c) =>
          /[",\n\r]/.test(c) || c === '' ? `"${c.replace(/"/g, '""')}"` : c,
        )
        .join(','),
    )
    .join(eol) + eol;

describe('S07 import CSV tokenizer (byte offsets)', () => {
  it('S07 AS-14: BOM, CRLF, quoted newline, doubled quotes and a blank line', () => {
    const text =
      '﻿ SKU , Title ,PRICE\r\n' +
      'A1,"Cable, braided","say ""hi""\nthere"\r\n' +
      '\r\n' +
      'A2,plain,2\r\n';
    const records = tokenise(Buffer.from(text));
    expect(records.map((r) => r.fields)).toEqual([
      [' SKU ', ' Title ', 'PRICE'],
      ['A1', 'Cable, braided', 'say "hi"\nthere'],
      [''],
      ['A2', 'plain', '2'],
    ]);
  });

  it('S07 AS-33: the end offset of a record is the byte where the next record starts', () => {
    const data = Buffer.from('a,b\nc,d\r\ne,f');
    const records = tokenise(data);
    expect(records.map((r) => [r.startOffset, r.endOffset])).toEqual([
      [0, 4],
      [4, 9],
      [9, 12],
    ]);
  });

  it('S07 AS-34: the BOM counts as bytes of the first record', () => {
    const data = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('a,b\nc,d\n'),
    ]);
    const records = tokenise(data);
    expect(records[0].fields).toEqual(['a', 'b']);
    expect(records[0].endOffset).toBe(3 + 4);
    expect(records[1].endOffset).toBe(data.length);
  });

  it('S07 AS-34: parsing again from any record end gives exactly the following records (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(cell, { minLength: 2, maxLength: 4 }), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.constantFrom('\n', '\r\n'),
        fc.boolean(),
        fc.array(fc.integer({ min: 1, max: 9 }), {
          minLength: 1,
          maxLength: 5,
        }),
        (rows, eol, bom, chunks) => {
          const body = Buffer.from(serialise(rows, eol));
          const data = bom
            ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
            : body;
          const all = tokenise(data, chunks);
          expect(all.map((r) => r.fields)).toEqual(rows);
          all.forEach((record, i) => {
            const resumed = new CsvTokenizer({ startOffset: record.endOffset });
            const rest = [
              ...resumed.push(data.subarray(record.endOffset)),
              ...resumed.end(),
            ];
            expect(rest.map((r) => r.fields)).toEqual(rows.slice(i + 1));
            expect(rest.map((r) => r.endOffset)).toEqual(
              all.slice(i + 1).map((r) => r.endOffset),
            );
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('S07 AS-14: it agrees with csv-parse on well-formed input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(cell, { minLength: 3, maxLength: 3 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (rows) => {
          const data = Buffer.from(serialise(rows, '\n'));
          const mine = tokenise(data, [7]).map((r) => r.fields);
          expect(mine).toEqual(parse(data, { relax_column_count: true }));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('S07 AS-42: a bare quote inside an unquoted field is a syntax error naming the byte', () => {
    const t = new CsvTokenizer();
    expect(() => t.push(Buffer.from('a,b\nc,d"e,f\n'))).toThrow(CsvSyntaxError);
  });

  it('S07 AS-42: text after a closing quote is a syntax error', () => {
    const t = new CsvTokenizer();
    expect(() => t.push(Buffer.from('a,"b"x,c\n'))).toThrow(CsvSyntaxError);
  });

  it('S07 AS-28: an unterminated quote ends the file inside a quote, which is a syntax error', () => {
    const t = new CsvTokenizer();
    t.push(Buffer.from('a,"b\nc,d\n'));
    expect(() => t.end()).toThrow(CsvSyntaxError);
  });

  it('S07 AS-28: a record larger than the limit is refused before it is buffered, naming where it started', () => {
    const t = new CsvTokenizer({ maxRecordBytes: 100 });
    t.push(Buffer.from('a,b\n'));
    const start = 4;
    try {
      t.push(Buffer.from('x,"' + 'y'.repeat(50)));
      t.push(Buffer.from('y'.repeat(100)));
      fail('expected RecordTooLargeError');
    } catch (error) {
      expect(error).toBeInstanceOf(RecordTooLargeError);
      expect((error as RecordTooLargeError).startOffset).toBe(start);
    }
  });
});

describe('S07 import JSON-lines splitter', () => {
  const split = (data: Buffer, chunk = data.length || 1, max = 1_048_576) => {
    const s = new JsonlSplitter({ maxLineBytes: max });
    const out: JsonlLine[] = [];
    for (let at = 0; at < data.length; at += chunk)
      out.push(...s.push(data.subarray(at, at + chunk)));
    out.push(...s.end());
    return out;
  };

  it('S07 AS-14: lines, CRLF, a BOM and blank lines are handled; offsets are exact', () => {
    const data = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"a":1}\r\n\n{"a":2}\n{"a":3}'),
    ]);
    const lines = split(data, 4);
    expect(lines.map((l) => l.text)).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
    expect(lines.map((l) => l.endOffset)).toEqual([
      3 + 9,
      3 + 9 + 1 + 8,
      data.length,
    ]);
  });

  it('S07 AS-28: an oversize line becomes one marker and parsing resumes at the next line', () => {
    const big = '{"x":"' + 'a'.repeat(2_000) + '"}';
    const data = Buffer.from(`{"a":1}\n${big}\n{"a":3}\n`);
    const lines = split(data, 100, 1000);
    expect(
      lines.map((l) => ('oversize' in l && l.oversize ? 'big' : l.text)),
    ).toEqual(['{"a":1}', 'big', '{"a":3}']);
    expect(lines[2].endOffset).toBe(data.length);
  });

  it('S07 AS-34: resuming at any line end gives the following lines (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({
            unit: fc.constantFrom(...'ab€"{}:, '.split('')),
            maxLength: 8,
          }),
          {
            minLength: 1,
            maxLength: 10,
          },
        ),
        fc.boolean(),
        (values, crlf) => {
          const eol = crlf ? '\r\n' : '\n';
          const lines = values.map((v) => `{"v":${JSON.stringify(v)}}`);
          const data = Buffer.from(lines.join(eol) + eol);
          const all = split(data, 5);
          expect(all.map((l) => l.text)).toEqual(lines);
          all.forEach((line, i) => {
            const s = new JsonlSplitter({ startOffset: line.endOffset });
            const rest = [...s.push(data.subarray(line.endOffset)), ...s.end()];
            expect(rest.map((l) => l.text)).toEqual(lines.slice(i + 1));
          });
        },
      ),
    );
  });
});
