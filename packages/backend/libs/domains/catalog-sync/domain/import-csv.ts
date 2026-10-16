/**
 * Incremental RFC 4180 tokenizer over bytes (S07 D-07). It exists because a resume needs the exact byte where the next
 * record starts: `endOffset` of a record is the offset right after its line terminator, BOM and CRLF included, so a
 * tokenizer started there with `startOffset` yields exactly the following records. Quotes, commas and newlines are
 * ASCII, so scanning bytes is safe for UTF-8; fields are decoded once, when complete.
 *
 * A bare quote inside an unquoted field, text after a closing quote and a quote that never closes are syntax errors
 * (the file is broken, not the row). A record larger than `maxRecordBytes` is refused before it is buffered further.
 */
export interface CsvRecord {
  fields: string[];
  startOffset: number;
  endOffset: number;
}

export class CsvSyntaxError extends Error {
  /** The complete records that preceded the break in the same call: the caller still delivers them. */
  records: CsvRecord[] = [];

  constructor(
    /** Where the record that broke started. */
    readonly startOffset: number,
    readonly offset: number,
  ) {
    super(`malformed CSV at byte ${offset}`);
    this.name = 'CsvSyntaxError';
  }
}

export class RecordTooLargeError extends Error {
  records: CsvRecord[] = [];

  constructor(readonly startOffset: number) {
    super(`record starting at byte ${startOffset} is too large`);
    this.name = 'RecordTooLargeError';
  }
}

export const MAX_RECORD_BYTES = 1_048_576;

const QUOTE = 0x22;
const COMMA = 0x2c;
const LF = 0x0a;
const CR = 0x0d;

const enum S {
  FieldStart,
  Unquoted,
  Quoted,
  AfterQuote,
  CrPending,
}

const BOM = [0xef, 0xbb, 0xbf];

export class CsvTokenizer {
  private pos: number;
  private recordStart: number;
  private state: S = S.FieldStart;
  private crFrom: S = S.FieldStart;
  private fields: string[] = [];
  private parts: Buffer[] = [];
  private partsBytes = 0;
  private bomBuf: Buffer | null;
  private readonly max: number;

  constructor(options: { startOffset?: number; maxRecordBytes?: number } = {}) {
    this.pos = options.startOffset ?? 0;
    this.recordStart = this.pos;
    this.max = options.maxRecordBytes ?? MAX_RECORD_BYTES;
    this.bomBuf = this.pos === 0 ? Buffer.alloc(0) : null;
  }

  push(input: Buffer): CsvRecord[] {
    let chunk = input;
    let skip = 0;
    if (this.bomBuf) {
      chunk = Buffer.concat([this.bomBuf, input]);
      if (chunk.length < 3) {
        this.bomBuf = chunk;
        return [];
      }
      this.bomBuf = null;
      if (BOM.every((b, i) => chunk[i] === b)) skip = 3;
    }
    return this.scan(chunk, skip);
  }

  end(): CsvRecord[] {
    const out: CsvRecord[] = [];
    if (this.bomBuf) {
      const rest = this.bomBuf;
      this.bomBuf = null;
      if (rest.length > 0) out.push(...this.scan(rest, 0));
    }
    if (this.state === S.Quoted) {
      const error = new CsvSyntaxError(this.recordStart, this.pos);
      error.records = out;
      throw error;
    }
    if (this.state === S.CrPending) {
      if (this.crFrom !== S.AfterQuote) this.addPart(Buffer.from([CR]));
      this.state = this.crFrom === S.AfterQuote ? S.AfterQuote : S.Unquoted;
    }
    if (this.pos > this.recordStart) out.push(this.finishRecord(this.pos));
    return out;
  }

  private addPart(buf: Buffer): void {
    this.parts.push(buf);
    this.partsBytes += buf.length;
  }

  private takeField(): string {
    const text =
      this.parts.length === 0
        ? ''
        : this.parts.length === 1
          ? this.parts[0].toString('utf8')
          : Buffer.concat(this.parts).toString('utf8');
    this.parts = [];
    this.partsBytes = 0;
    return text;
  }

  private finishRecord(endOffset: number): CsvRecord {
    this.fields.push(this.takeField());
    const record: CsvRecord = {
      fields: this.fields,
      startOffset: this.recordStart,
      endOffset,
    };
    this.fields = [];
    this.recordStart = endOffset;
    this.state = S.FieldStart;
    return record;
  }

  private scan(chunk: Buffer, skip: number): CsvRecord[] {
    const out: CsvRecord[] = [];
    try {
      return this.scanInto(chunk, skip, out);
    } catch (error) {
      if (
        error instanceof CsvSyntaxError ||
        error instanceof RecordTooLargeError
      )
        error.records = out;
      throw error;
    }
  }

  private scanInto(chunk: Buffer, skip: number, out: CsvRecord[]): CsvRecord[] {
    const base = this.pos; // absolute offset of chunk[0]
    let segStart = skip;
    let state = this.state;
    const flush = (end: number) => {
      if (end > segStart)
        this.addPart(Buffer.from(chunk.subarray(segStart, end)));
    };
    for (let i = skip; i < chunk.length; i++) {
      const b = chunk[i];
      switch (state) {
        case S.FieldStart:
          if (b === QUOTE) {
            state = S.Quoted;
            segStart = i + 1;
          } else if (b === COMMA) {
            this.fields.push('');
          } else if (b === LF) {
            out.push(this.finishRecord(base + i + 1));
            state = S.FieldStart;
            segStart = i + 1;
          } else if (b === CR) {
            this.crFrom = S.FieldStart;
            state = S.CrPending;
          } else {
            state = S.Unquoted;
            segStart = i;
          }
          break;
        case S.Unquoted:
          if (b === COMMA) {
            flush(i);
            this.fields.push(this.takeField());
            state = S.FieldStart;
          } else if (b === LF) {
            flush(i);
            out.push(this.finishRecord(base + i + 1));
            state = S.FieldStart;
            segStart = i + 1;
          } else if (b === CR) {
            flush(i);
            this.crFrom = S.Unquoted;
            state = S.CrPending;
          } else if (b === QUOTE) {
            throw new CsvSyntaxError(this.recordStart, base + i);
          }
          break;
        case S.Quoted:
          if (b === QUOTE) {
            flush(i);
            state = S.AfterQuote;
          }
          break;
        case S.AfterQuote:
          if (b === QUOTE) {
            this.addPart(Buffer.from([QUOTE]));
            state = S.Quoted;
            segStart = i + 1;
          } else if (b === COMMA) {
            this.fields.push(this.takeField());
            state = S.FieldStart;
          } else if (b === LF) {
            out.push(this.finishRecord(base + i + 1));
            state = S.FieldStart;
            segStart = i + 1;
          } else if (b === CR) {
            this.crFrom = S.AfterQuote;
            state = S.CrPending;
          } else {
            throw new CsvSyntaxError(this.recordStart, base + i);
          }
          break;
        case S.CrPending:
          if (b === LF) {
            out.push(this.finishRecord(base + i + 1));
            state = S.FieldStart;
            segStart = i + 1;
          } else if (this.crFrom === S.AfterQuote) {
            throw new CsvSyntaxError(this.recordStart, base + i);
          } else {
            // the carriage return was data
            this.addPart(Buffer.from([CR]));
            state = S.Unquoted;
            segStart = i;
            i--; // reprocess this byte as unquoted data
          }
          break;
        default:
          throw new Error('unreachable CSV state');
      }
      if (this.partsBytes + (i - segStart) > this.max)
        throw new RecordTooLargeError(this.recordStart);
    }
    // keep the unfinished segment
    if (state === S.Quoted || state === S.Unquoted) flush(chunk.length);
    this.pos = base + chunk.length;
    this.state = state;
    if (this.pos - this.recordStart > this.max)
      throw new RecordTooLargeError(this.recordStart);
    return out;
  }
}
