import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export const SNAPSHOT_FORMAT = 1;

export interface SnapshotParams {
  windowDays: number;
  minSearchers: number;
  cap: number;
  k: number;
  depth: number;
}

export interface SnapshotEntry {
  query: string;
  searchers: number;
}

export interface SnapshotEnvelope {
  format: number;
  version: string;
  createdAt: string;
  params: SnapshotParams;
  checksum: string;
  entries: SnapshotEntry[];
}

export type SnapshotLoadReason =
  'corrupt' | 'format' | 'checksum' | 'invalid_entry';

/** A snapshot that cannot be trusted; `reason` is the bounded label of the failure metric. */
export class SnapshotLoadError extends Error {
  constructor(readonly reason: SnapshotLoadReason) {
    super(`snapshot rejected: ${reason}`);
    this.name = 'SnapshotLoadError';
  }
}

/** Entries order: most searchers first, ties by query text (code-unit order), so a build is deterministic. */
export const compareEntries = (a: SnapshotEntry, b: SnapshotEntry): number =>
  b.searchers - a.searchers ||
  (a.query < b.query ? -1 : a.query > b.query ? 1 : 0);

export const checksumOf = (entries: SnapshotEntry[]): string =>
  createHash('sha256').update(JSON.stringify(entries)).digest('hex');

/** The gzip JSON envelope: only `{query, searchers}` per entry, never a user id (SC-009). */
export function encodeSnapshot(input: {
  version: string;
  createdAt: Date;
  params: SnapshotParams;
  entries: SnapshotEntry[];
}): Buffer {
  const entries = input.entries
    .map((e) => ({ query: e.query, searchers: e.searchers }))
    .sort(compareEntries);
  const envelope: SnapshotEnvelope = {
    format: SNAPSHOT_FORMAT,
    version: input.version,
    createdAt: input.createdAt.toISOString(),
    params: input.params,
    checksum: checksumOf(entries),
    entries,
  };
  return gzipSync(JSON.stringify(envelope));
}

const isEntry = (value: unknown): value is SnapshotEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  const e = value as Record<string, unknown>;
  return (
    keys.length === 2 &&
    typeof e.query === 'string' &&
    e.query.length > 0 &&
    Number.isInteger(e.searchers) &&
    (e.searchers as number) > 0
  );
};

/** Verifies and parses a snapshot; throws `SnapshotLoadError` naming why it cannot be used. */
export function decodeSnapshot(bytes: Buffer): SnapshotEnvelope {
  let doc: Partial<SnapshotEnvelope>;
  try {
    doc = JSON.parse(gunzipSync(bytes).toString('utf8'));
  } catch {
    throw new SnapshotLoadError('corrupt');
  }
  if (typeof doc !== 'object' || doc === null)
    throw new SnapshotLoadError('corrupt');
  if (doc.format !== SNAPSHOT_FORMAT) throw new SnapshotLoadError('format');
  if (!Array.isArray(doc.entries)) throw new SnapshotLoadError('corrupt');
  if (doc.checksum !== checksumOf(doc.entries))
    throw new SnapshotLoadError('checksum');
  const seen = new Set<string>();
  for (const entry of doc.entries) {
    if (!isEntry(entry) || seen.has(entry.query))
      throw new SnapshotLoadError('invalid_entry');
    seen.add(entry.query);
  }
  return doc as SnapshotEnvelope;
}
