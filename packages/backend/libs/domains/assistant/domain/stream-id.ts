/** Redis stream entry ids (`<ms>-<seq>`) double as SSE event ids (S46 R-5). Parts can exceed 2^53, so they are BigInts. */
export interface StreamId {
  ms: bigint;
  seq: bigint;
}

const STREAM_ID = /^(\d+)-(\d+)$/;

export function parseStreamId(id: string): StreamId | null {
  const match = STREAM_ID.exec(id);
  return match ? { ms: BigInt(match[1]), seq: BigInt(match[2]) } : null;
}

export function isStreamId(id: string): boolean {
  return STREAM_ID.test(id);
}

export function formatStreamId(id: StreamId): string {
  return `${id.ms}-${id.seq}`;
}

/** Numeric order, never lexical (`9-0` < `10-0`). Throws on a malformed id: callers validate first (AS-24). */
export function compareStreamIds(a: string, b: string): number {
  const left = parseStreamId(a);
  const right = parseStreamId(b);
  if (!left || !right) throw new Error('Malformed stream id');
  if (left.ms !== right.ms) return left.ms < right.ms ? -1 : 1;
  if (left.seq !== right.seq) return left.seq < right.seq ? -1 : 1;
  return 0;
}
