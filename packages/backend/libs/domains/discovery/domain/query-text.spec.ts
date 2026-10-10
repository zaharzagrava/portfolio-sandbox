import {
  MAX_QUERY_LENGTH,
  exceedsQueryLimit,
  logForm,
  normaliseQuery,
  redactQuery,
} from './query-text';

describe('query normalisation (S32 AS-85)', () => {
  it.each([
    ['ＩＰＨＯＮＥ　１５', 'IPHONE 15'],
    ['ﬁsh', 'fish'],
    ['  espresso   machine  ', 'espresso machine'],
    ['a\tb\nc\r\nd', 'a b c d'],
    ['he\u0000llo\u0007 wo\u001frld\u007f', 'hello world'],
    ['zero​width', 'zero​width'],
    ['Mixed CASE', 'Mixed CASE'],
    ['', ''],
    ['   ', ''],
  ])('S32 AS-85: normalises %j to %j', (input, expected) => {
    expect(normaliseQuery(input)).toBe(expected);
  });

  it('S32 AS-85: control characters inside words do not split them, whitespace-class controls do', () => {
    expect(normaliseQuery('a\u0000b')).toBe('ab');
    expect(normaliseQuery('a\tb')).toBe('a b');
  });

  it('S32 AS-85: the 100-character cap is a check, not a truncation', () => {
    const ok = 'a'.repeat(MAX_QUERY_LENGTH);
    const long = 'a'.repeat(MAX_QUERY_LENGTH + 1);
    expect(exceedsQueryLimit(ok)).toBe(false);
    expect(exceedsQueryLimit(long)).toBe(true);
    expect(normaliseQuery(long)).toBe(long);
  });

  it('S32 AS-85: the cap counts the normalised text', () => {
    expect(exceedsQueryLimit(` ${'a'.repeat(100)} `)).toBe(false);
    expect(exceedsQueryLimit('ａ'.repeat(100))).toBe(false);
  });
});

describe('query redaction (S32 AS-85)', () => {
  it.each([
    ['mail me at john.doe+x@example.com now', 'mail me at [redacted] now'],
    ['call 1234567890', 'call [redacted]'],
    ['call 123456789', 'call [redacted]'],
    ['call 12345678', 'call 12345678'],
    ['call 555-123-4567', 'call [redacted]'],
    ['4111 1111 1111 1111', '[redacted]'],
    ['4111-1111-1111-1111 visa', '[redacted] visa'],
    ['iphone 15 pro 256gb', 'iphone 15 pro 256gb'],
    ['a@b.co and c@d.io', '[redacted] and [redacted]'],
    ['ssd 1234', 'ssd 1234'],
  ])('S32 AS-85: redacts %j to %j', (input, expected) => {
    expect(redactQuery(input)).toBe(expected);
  });

  it('S32 AS-85: logForm lower-cases and redacts; queries under two characters are not logged', () => {
    expect(logForm('iPhone 15')).toBe('iphone 15');
    expect(logForm('Mail A@B.com')).toBe('mail [redacted]');
    expect(logForm('a')).toBeNull();
    expect(logForm('  ')).toBeNull();
    expect(logForm('')).toBeNull();
    expect(logForm('ab')).toBe('ab');
  });
});
