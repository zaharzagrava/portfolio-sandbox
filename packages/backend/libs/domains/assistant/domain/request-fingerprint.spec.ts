import { requestFingerprint } from './request-fingerprint';

const base = { conversationId: 'c1', text: 'hello there' };

describe('S46 AS-65: request fingerprint', () => {
  it('is a 64 char hex SHA-256', () => {
    expect(requestFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['surrounding whitespace', { ...base, text: '  hello there \n' }],
    ['field order', { text: 'hello there', conversationId: 'c1' }],
    [
      'explicit undefined location',
      { ...base, lat: undefined, lng: undefined },
    ],
  ])('S46 AS-65: same body despite %s', (_n, other) => {
    expect(requestFingerprint(other)).toBe(requestFingerprint(base));
  });

  it.each([
    ['52.5', 52.5, 13.4, 52.5, 13.4],
    ['52.500000 vs 52.5', 52.5, 13.4, 52.5, 13.4],
    [
      'seventh decimal is below the precision',
      52.5,
      13.4,
      52.50000001,
      13.4000000001,
    ],
    ['integer vs decimal', 52, 13, 52.0, 13.0],
  ])('S46 AS-65: number format %s', (_n, a1, a2, b1, b2) => {
    expect(requestFingerprint({ ...base, lat: a1, lng: a2 })).toBe(
      requestFingerprint({ ...base, lat: b1, lng: b2 }),
    );
  });

  it.each([
    ['another text', base, { ...base, text: 'hello there!' }],
    ['inner whitespace differs', base, { ...base, text: 'hello  there' }],
    ['another conversation', base, { ...base, conversationId: 'c2' }],
    ['a location added', base, { ...base, lat: 1, lng: 2 }],
    [
      'another latitude',
      { ...base, lat: 1, lng: 2 },
      { ...base, lat: 1.000001, lng: 2 },
    ],
    [
      'another longitude',
      { ...base, lat: 1, lng: 2 },
      { ...base, lat: 1, lng: 2.000001 },
    ],
  ])('S46 AS-65: different body (%s) gives another fingerprint', (_n, a, b) => {
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(b));
  });

  it('S46 AS-65: a text that looks like a delimiter cannot collide with a location', () => {
    expect(
      requestFingerprint({ conversationId: 'c1', text: 'a","lat":"1' }),
    ).not.toBe(
      requestFingerprint({ conversationId: 'c1', text: 'a', lat: 1, lng: 1 }),
    );
  });
});
