/**
 * Time-based identifiers (S25 FR-003, A3, B7). A version-1 UUID whose embedded time is the creation time read from the
 * injected clock, so ordering by ID is ordering by creation time and `createdAt` is derivable from the ID. Pure: the
 * clock value and the random bytes come in as arguments; nothing here reads the wall clock or `node:crypto`.
 */

/** Supplies random bytes (infrastructure binds `crypto.randomBytes`; tests bind a seeded source). */
export interface RandomSource {
  bytes(length: number): Uint8Array;
}

/** 100-nanosecond intervals between 1582-10-15 (UUID epoch) and 1970-01-01. */
const UUID_EPOCH_OFFSET_MS = 12_219_292_800_000n;
const TICKS_PER_MS = 10_000;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Generates unique, creation-ordered IDs. Within one process, IDs created in the same millisecond take increasing
 * 100 ns ticks, so they sort in creation order; across processes the random node bytes keep them unique and the
 * order inside one millisecond is stable (the tiebreak is the remaining bytes).
 */
export class TimeIdGenerator {
  private lastMs = -1;
  private ticks = 0;

  constructor(private readonly random: RandomSource) {}

  next(createdAt: Date): string {
    const ms = createdAt.getTime();
    if (ms === this.lastMs) this.ticks = (this.ticks + 1) % TICKS_PER_MS;
    else {
      this.lastMs = ms;
      this.ticks = 0;
    }
    const timestamp =
      (BigInt(ms) + UUID_EPOCH_OFFSET_MS) * BigInt(TICKS_PER_MS) +
      BigInt(this.ticks);
    const timeLow = (timestamp & 0xffffffffn).toString(16).padStart(8, '0');
    const timeMid = ((timestamp >> 32n) & 0xffffn)
      .toString(16)
      .padStart(4, '0');
    const timeHigh = (((timestamp >> 48n) & 0x0fffn) | 0x1000n)
      .toString(16)
      .padStart(4, '0');
    const rest = this.random.bytes(8);
    rest[0] = (rest[0] & 0x3f) | 0x80; // RFC 4122 variant
    const r = hex(rest);
    return `${timeLow}-${timeMid}-${timeHigh}-${r.slice(0, 4)}-${r.slice(4)}`;
  }
}

const UUID_V1 =
  /^([0-9a-f]{8})-([0-9a-f]{4})-(1[0-9a-f]{3})-([0-9a-f]{4})-([0-9a-f]{12})$/;

export const isTimeUuid = (value: string): boolean =>
  UUID_V1.test(value.toLowerCase());

/** 32 hex characters with the timestamp first: lexicographic order is creation order (Redis ZSET members, paths). */
export function sortableId(id: string): string {
  const m = UUID_V1.exec(id.toLowerCase());
  if (!m) throw new RangeError('not a time-based UUID');
  return `${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}`;
}

/** Inverse of `sortableId`. */
export function fromSortableId(sortable: string): string {
  if (!/^1[0-9a-f]{31}$/.test(sortable))
    throw new RangeError('not a sortable id');
  const th = sortable.slice(0, 4);
  const tm = sortable.slice(4, 8);
  const tl = sortable.slice(8, 16);
  return `${tl}-${tm}-${th}-${sortable.slice(16, 20)}-${sortable.slice(20)}`;
}

/** The creation time embedded in the ID (millisecond precision). */
export function idTime(id: string): Date {
  const m = UUID_V1.exec(id.toLowerCase());
  if (!m) throw new RangeError('not a time-based UUID');
  const timestamp = BigInt(`0x${m[3].slice(1)}${m[2]}${m[1]}`);
  return new Date(
    Number(timestamp / BigInt(TICKS_PER_MS) - UUID_EPOCH_OFFSET_MS),
  );
}

/** Creation order of two IDs (negative: `a` is older); equal timestamps fall back to the stable byte order. */
export const compareTimeUuid = (a: string, b: string): number => {
  const x = sortableId(a);
  const y = sortableId(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
