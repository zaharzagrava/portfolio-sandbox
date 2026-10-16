import { MAX_RECORD_BYTES } from './import-csv';

/**
 * Incremental JSON-lines splitter over bytes (S07 FR-012, D-07). A line is the bytes up to a line feed (a trailing
 * carriage return is dropped); blank lines are skipped; `endOffset` is the byte where the next line starts, so a
 * splitter started there yields the following lines. A line larger than `maxLineBytes` is not buffered: it is reported
 * once as `oversize` and the splitter resynchronises at the next line feed.
 */
export interface JsonlLine {
  /** The decoded line, or `null` for an oversize one. */
  text: string | null;
  oversize: boolean;
  startOffset: number;
  endOffset: number;
}

const LF = 0x0a;
const BOM = [0xef, 0xbb, 0xbf];

export class JsonlSplitter {
  private pos: number;
  private lineStart: number;
  private parts: Buffer[] = [];
  private lineBytes = 0;
  private oversize = false;
  private bomBuf: Buffer | null;
  private readonly max: number;

  constructor(options: { startOffset?: number; maxLineBytes?: number } = {}) {
    this.pos = options.startOffset ?? 0;
    this.lineStart = this.pos;
    this.max = options.maxLineBytes ?? MAX_RECORD_BYTES;
    this.bomBuf = this.pos === 0 ? Buffer.alloc(0) : null;
  }

  push(input: Buffer): JsonlLine[] {
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

  end(): JsonlLine[] {
    const out: JsonlLine[] = [];
    if (this.bomBuf) {
      const rest = this.bomBuf;
      this.bomBuf = null;
      if (rest.length > 0) out.push(...this.scan(rest, 0));
    }
    const last = this.finishLine(this.pos);
    if (last) out.push(last);
    return out;
  }

  private finishLine(endOffset: number): JsonlLine | null {
    const startOffset = this.lineStart;
    const oversize = this.oversize;
    const parts = this.parts;
    this.parts = [];
    this.lineBytes = 0;
    this.oversize = false;
    this.lineStart = endOffset;
    if (oversize) return { text: null, oversize: true, startOffset, endOffset };
    const text = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
    if (text.trim() === '') return null;
    return { text, oversize: false, startOffset, endOffset };
  }

  private scan(chunk: Buffer, skip: number): JsonlLine[] {
    const out: JsonlLine[] = [];
    const base = this.pos;
    let from = skip;
    for (;;) {
      const nl = chunk.indexOf(LF, from);
      const end = nl === -1 ? chunk.length : nl;
      const length = end - from;
      this.lineBytes += length;
      if (!this.oversize) {
        if (this.lineBytes > this.max) {
          this.oversize = true;
          this.parts = [];
        } else if (length > 0) {
          this.parts.push(Buffer.from(chunk.subarray(from, end)));
        }
      }
      if (nl === -1) break;
      const line = this.finishLine(base + nl + 1);
      if (line) out.push(line);
      from = nl + 1;
    }
    this.pos = base + chunk.length;
    return out;
  }
}
