import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { chunk, chunkBoundaries, DEFAULT_PARAMS } from './fastcdc';

/** Used by the sync CLI/clients and by the server's integrity checks - pure → unit spec. */
describe('FastCDC', () => {
  const params = { min: 2 * 1024, avg: 8 * 1024, max: 32 * 1024 };
  const file = randomBytes(1024 * 1024);

  it('covers the file exactly with chunks within [min, max]', () => {
    const chunks = chunk(file, params);
    expect(chunks.reduce((s, c) => s + c.length, 0)).toBe(file.length);
    for (const c of chunks.slice(0, -1)) {
      expect(c.length).toBeGreaterThanOrEqual(params.min);
      expect(c.length).toBeLessThanOrEqual(params.max);
    }
    const mean = file.length / chunks.length;
    expect(mean).toBeGreaterThan(params.avg * 0.6);
    expect(mean).toBeLessThan(params.avg * 1.6);
  });

  it('an insertion in the middle changes only a few chunks (content-defined, not offset-defined)', () => {
    const before = chunk(file, params);
    const edited = Buffer.concat([
      file.subarray(0, 500_000),
      Buffer.from('INSERTED BYTES'),
      file.subarray(500_000),
    ]);
    const after = chunk(edited, params);
    const known = new Set(before.map((c) => c.hash));
    const changed = after.filter((c) => !known.has(c.hash));
    expect(changed.length).toBeLessThanOrEqual(3);
    expect(after.length - changed.length).toBeGreaterThan(before.length * 0.9);
  });

  it('is deterministic', () => {
    expect(chunk(file, params).map((c) => c.hash)).toEqual(
      chunk(Buffer.from(file), params).map((c) => c.hash),
    );
  });
});

/** S31 AS-77: the chunker with the test parameters (4/16/64 KiB) and the production ones (1/4/16 MiB). */
describe('S31 AS-77 chunker properties', () => {
  const test = { min: 4 * 1024, avg: 16 * 1024, max: 64 * 1024 };
  const parameterSets = [
    ['test parameters', test],
    ['production parameters', DEFAULT_PARAMS],
  ] as const;

  const bytes = (n: number) =>
    fc.uint8Array({ minLength: n, maxLength: n }).map((a) => Buffer.from(a));

  it.each(parameterSets)(
    'S31 AS-77: an empty input yields no chunks (%s)',
    (_name, p) => {
      expect(chunk(new Uint8Array(0), p)).toEqual([]);
      expect(chunkBoundaries(new Uint8Array(0), p)).toEqual([]);
    },
  );

  it.each(parameterSets)(
    'S31 AS-77: an input not longer than min is one chunk (%s)',
    (_name, p) => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 4096 }), (n) => {
          const data = randomBytes(n);
          const chunks = chunk(data, p);
          expect(chunks).toHaveLength(1);
          expect(chunks[0].length).toBe(n);
        }),
        { numRuns: 20 },
      );
    },
  );

  it('S31 AS-77: concatenating the chunks reproduces the input, within bounds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400_000 }).chain((n) => bytes(n)),
        (data) => {
          const chunks = chunk(data, test);
          const joined = Buffer.concat(
            chunks.map((c) => data.subarray(c.offset, c.offset + c.length)),
          );
          expect(joined.equals(data)).toBe(true);
          chunks.forEach((c, i) => {
            expect(c.length).toBeLessThanOrEqual(test.max);
            if (i < chunks.length - 1) {
              expect(c.length).toBeGreaterThanOrEqual(test.min);
            }
          });
          expect(chunks.length === 0).toBe(data.length === 0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('S31 AS-77: the same input gives the same boundaries on every run', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 300_000 }).chain((n) => bytes(n)),
        (data) => {
          expect(chunkBoundaries(data, test)).toEqual(
            chunkBoundaries(Buffer.from(data), test),
          );
        },
      ),
      { numRuns: 20 },
    );
  });

  it('S31 AS-77: one insertion changes at most 3 chunk hashes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        (_seed, where, inserted) => {
          const data = randomBytes(600_000);
          const at = Math.floor(where * data.length);
          const edited = Buffer.concat([
            data.subarray(0, at),
            Buffer.from(inserted),
            data.subarray(at),
          ]);
          const known = new Set(chunk(data, test).map((c) => c.hash));
          const changed = chunk(edited, test).filter((c) => !known.has(c.hash));
          expect(changed.length).toBeLessThanOrEqual(3);
        },
      ),
      { numRuns: 15 },
    );
  });

  it.each(parameterSets)(
    'S31 AS-77: the mean chunk size is within 0.6-1.6 times avg (%s)',
    (_name, p) => {
      const size = p === test ? 2 * 1024 * 1024 : 96 * 1024 * 1024;
      const data = randomBytes(size);
      const chunks = chunk(data, p);
      const mean = size / chunks.length;
      expect(mean).toBeGreaterThan(p.avg * 0.6);
      expect(mean).toBeLessThan(p.avg * 1.6);
    },
    60_000,
  );
});
