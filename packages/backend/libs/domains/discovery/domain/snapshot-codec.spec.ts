import { gunzipSync, gzipSync } from 'node:zlib';
import {
  checksumOf,
  decodeSnapshot,
  encodeSnapshot,
  SnapshotLoadError,
  type SnapshotEnvelope,
} from './snapshot-codec';

const params = {
  windowDays: 30,
  minSearchers: 5,
  cap: 200_000,
  k: 10,
  depth: 20,
};
const entries = [
  { query: 'iphone charger', searchers: 20 },
  { query: 'iphone 17', searchers: 50 },
  { query: 'airpods', searchers: 20 },
];
const encode = () =>
  encodeSnapshot({
    version: '2026-10-10T10-00-00-000Z-aaaa',
    createdAt: new Date('2026-10-10T10:00:00.000Z'),
    params,
    entries,
  });
const raw = (buf: Buffer): SnapshotEnvelope & Record<string, unknown> =>
  JSON.parse(gunzipSync(buf).toString('utf8'));
const repack = (doc: unknown) => gzipSync(JSON.stringify(doc));
const reason = (buf: Buffer): string | undefined => {
  try {
    decodeSnapshot(buf);
  } catch (e) {
    return e instanceof SnapshotLoadError ? e.reason : 'other';
  }
  return undefined;
};

describe('snapshot codec', () => {
  it('S33 AS-40: round trip, entries sorted by searchers desc then query asc, no user ids', () => {
    const buf = encode();
    const out = decodeSnapshot(buf);
    expect(out.format).toBe(1);
    expect(out.version).toBe('2026-10-10T10-00-00-000Z-aaaa');
    expect(out.params).toEqual(params);
    expect(out.entries).toEqual([
      { query: 'iphone 17', searchers: 50 },
      { query: 'airpods', searchers: 20 },
      { query: 'iphone charger', searchers: 20 },
    ]);
    expect(out.checksum).toBe(checksumOf(out.entries));
    expect(Object.keys(raw(buf).entries[0]).sort()).toEqual([
      'query',
      'searchers',
    ]);
  });

  it('S33 AS-40: the same entries in another order give the same checksum', () => {
    const a = decodeSnapshot(encode());
    const b = decodeSnapshot(
      encodeSnapshot({
        version: 'other',
        createdAt: new Date(),
        params,
        entries: [...entries].reverse(),
      }),
    );
    expect(b.checksum).toBe(a.checksum);
  });

  it.each([
    [
      'a changed entry → checksum',
      () => {
        const doc = raw(encode());
        doc.entries[0].searchers += 1;
        return repack(doc);
      },
      'checksum',
    ],
    ['truncated bytes → corrupt', () => encode().subarray(0, 20), 'corrupt'],
    [
      'not compressed → corrupt',
      () => Buffer.from('not gzip at all'),
      'corrupt',
    ],
    ['compressed non-JSON → corrupt', () => gzipSync('{nope'), 'corrupt'],
    [
      'unknown format → format',
      () => repack({ ...raw(encode()), format: 2 }),
      'format',
    ],
    [
      'an invalid entry → invalid_entry',
      () => {
        const doc = raw(encode());
        doc.entries = [{ query: '', searchers: 3 }] as never;
        doc.checksum = checksumOf(doc.entries);
        return repack(doc);
      },
      'invalid_entry',
    ],
    [
      'an entry with an extra field → invalid_entry',
      () => {
        const doc = raw(encode());
        doc.entries = [{ query: 'a b', searchers: 3, userId: 'u1' }] as never;
        doc.checksum = checksumOf(doc.entries);
        return repack(doc);
      },
      'invalid_entry',
    ],
    [
      'a duplicate entry → invalid_entry',
      () => {
        const doc = raw(encode());
        doc.entries = [doc.entries[0], doc.entries[0]];
        doc.checksum = checksumOf(doc.entries);
        return repack(doc);
      },
      'invalid_entry',
    ],
  ])('S33 AS-40: %s', (_name, make, expected) => {
    expect(reason(make())).toBe(expected);
  });
});
