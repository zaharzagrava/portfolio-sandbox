/** Board listing buckets (S25 D5): one partition per (board, month), `bucket = yyyymm` in UTC. */
export const monthBucketOf = (at: Date): number =>
  at.getUTCFullYear() * 100 + at.getUTCMonth() + 1;

export const previousMonth = (bucket: number): number =>
  bucket % 100 === 1 ? (Math.floor(bucket / 100) - 1) * 100 + 12 : bucket - 1;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `yyyymmddhh` of an instant in UTC. */
export const hourOf = (at: Date): number =>
  Number(
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}`,
  );

/** `yyyymmdd` of an instant in UTC (the reconciliation worklist partition). */
export const dayOf = (at: Date): number => Math.floor(hourOf(at) / 100);
