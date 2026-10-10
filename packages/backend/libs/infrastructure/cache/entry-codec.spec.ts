import { InvalidLoaderResult } from './cache.errors';
import { encodeEnvelope, parseEnvelope, Envelope } from './entry-codec';

const envelope = (
  over: Partial<Envelope<unknown>> = {},
): Envelope<unknown> => ({
  v: { n: 1 },
  exp: 2_000,
  hard: 3_000,
  delta: 12,
  ...over,
});

describe('Entry codec', () => {
  it('S52 AS-07: encode then parse round-trips every field', () => {
    const encoded = encodeEnvelope(envelope({ ver: 4 }), 1024);
    expect(encoded.kind).toBe('ok');
    if (encoded.kind !== 'ok') return;
    expect(parseEnvelope(encoded.payload)).toEqual({
      kind: 'ok',
      envelope: envelope({ ver: 4 }),
    });
  });

  it('S52 AS-22: a negative entry round-trips with a null value', () => {
    const encoded = encodeEnvelope(envelope({ v: null, hard: 2_000 }), 1024);
    if (encoded.kind !== 'ok') throw new Error('expected ok');
    const parsed = parseEnvelope(encoded.payload);
    expect(parsed).toMatchObject({ kind: 'ok', envelope: { v: null } });
  });

  it('S52 AS-07: no stored bytes is a miss, not corruption', () => {
    expect(parseEnvelope(null)).toEqual({ kind: 'miss' });
  });

  it.each([
    ['garbage bytes', '\u0000\u0001not json'],
    ['truncated json', '{"v":1,"exp":'],
    ['a json string', '"hello"'],
    ['a json array', '[1,2,3]'],
    ['null', 'null'],
    ['an object without the envelope fields', '{"x":1}'],
    ['a missing value field', '{"exp":1,"hard":2,"delta":0}'],
    ['a non-numeric expiry', '{"v":1,"exp":"soon","hard":2,"delta":0}'],
    [
      'a hard expiry before the soft expiry',
      '{"v":1,"exp":5,"hard":2,"delta":0}',
    ],
    ['a fractional version', '{"v":1,"exp":1,"hard":2,"delta":0,"ver":1.5}'],
  ])('S52 AS-07: %s is corrupt', (_name, raw) => {
    expect(parseEnvelope(raw)).toEqual({ kind: 'corrupt' });
  });

  it.each([
    ['undefined', undefined],
    ['a function', () => 1],
    ['a symbol', Symbol('x')],
    ['a BigInt', BigInt(10)],
    [
      'a cyclic object',
      (() => {
        const a: Record<string, unknown> = {};
        a.self = a;
        return a;
      })(),
    ],
  ])('S52 AS-06: %s as a value is an InvalidLoaderResult', (_name, value) => {
    expect(() => encodeEnvelope(envelope({ v: value }), 1024)).toThrow(
      InvalidLoaderResult,
    );
  });

  it('S52 AS-08: an entry over the cap is reported oversize and never encoded for storage', () => {
    const big = 'x'.repeat(2_000);
    const result = encodeEnvelope(envelope({ v: big }), 1_000);
    expect(result.kind).toBe('oversize');
    expect(result.bytes).toBeGreaterThan(2_000);
  });

  it('S52 AS-08: the cap counts bytes, not characters', () => {
    const result = encodeEnvelope(envelope({ v: 'é'.repeat(600) }), 1_000);
    expect(result.kind).toBe('oversize');
  });

  it('S52 AS-08: an entry exactly at the cap is stored', () => {
    const probe = encodeEnvelope(envelope({ v: '' }), 10_000);
    if (probe.kind !== 'ok') throw new Error('expected ok');
    const atCap = encodeEnvelope(
      envelope({ v: 'x'.repeat(100) }),
      probe.bytes + 100,
    );
    expect(atCap.kind).toBe('ok');
    const over = encodeEnvelope(
      envelope({ v: 'x'.repeat(101) }),
      probe.bytes + 100,
    );
    expect(over.kind).toBe('oversize');
  });
});
