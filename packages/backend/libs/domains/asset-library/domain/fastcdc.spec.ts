import { randomBytes } from 'node:crypto';
import { chunk } from './fastcdc';

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
