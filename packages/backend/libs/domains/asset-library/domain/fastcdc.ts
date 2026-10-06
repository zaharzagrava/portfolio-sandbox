import { createHash } from 'node:crypto';

/**
 * FastCDC (Xia et al., 2016) content-defined chunking (10/08 #25). Chunk
 * boundaries come from the CONTENT (a rolling "gear" hash hitting a mask),
 * not from fixed offsets - so inserting a byte in the middle of a 2 GB file
 * changes ~1-2 chunks instead of every chunk after the edit, and only those
 * are re-uploaded. Normalized chunking: a stricter mask before the average
 * size and a looser one after keeps chunk sizes tight around `avg`.
 */
export interface ChunkingParams {
  min: number;
  avg: number;
  max: number;
}

/** Production sizes: 1 MB / 4 MB / 16 MB. */
export const DEFAULT_PARAMS: ChunkingParams = { min: 1 << 20, avg: 4 << 20, max: 16 << 20 };

/** 256 pseudo-random 32-bit values, fixed forever (changing them would change every boundary and kill dedupe). */
const GEAR = (() => {
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    table[i] = state >>> 0;
  }
  return table;
})();

const bits = (n: number) => Math.round(Math.log2(n));
const maskOf = (n: number) => (2 ** n - 1) >>> 0;

export interface Chunk {
  offset: number;
  length: number;
  hash: string;
}

export function chunkBoundaries(data: Uint8Array, params: ChunkingParams = DEFAULT_PARAMS): number[] {
  const avgBits = bits(params.avg);
  // Spread mask bits over the high part of the word (gear hash mixes upward).
  const maskS = (maskOf(avgBits + 1) << (31 - avgBits)) >>> 0; // harder before avg
  const maskL = (maskOf(avgBits - 1) << (33 - avgBits)) >>> 0; // easier after avg
  const cuts: number[] = [];
  let start = 0;
  while (start < data.length) {
    const remaining = data.length - start;
    if (remaining <= params.min) {
      cuts.push(data.length);
      break;
    }
    const end = Math.min(remaining, params.max);
    const normal = Math.min(end, params.avg);
    let hash = 0;
    let i = params.min;
    let cut = end;
    for (; i < normal; i++) {
      hash = ((hash << 1) + GEAR[data[start + i]]) >>> 0;
      if ((hash & maskS) === 0) {
        cut = i + 1;
        break;
      }
    }
    if (cut === end && i >= normal) {
      for (; i < end; i++) {
        hash = ((hash << 1) + GEAR[data[start + i]]) >>> 0;
        if ((hash & maskL) === 0) {
          cut = i + 1;
          break;
        }
      }
    }
    start += cut;
    cuts.push(start);
  }
  return cuts;
}

export function chunk(data: Uint8Array, params: ChunkingParams = DEFAULT_PARAMS): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 0;
  for (const cut of chunkBoundaries(data, params)) {
    const slice = data.subarray(offset, cut);
    chunks.push({ offset, length: slice.length, hash: createHash('sha256').update(slice).digest('hex') });
    offset = cut;
  }
  return chunks;
}
