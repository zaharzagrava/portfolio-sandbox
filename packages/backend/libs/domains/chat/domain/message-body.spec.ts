import { CHAT_BODY_MAX, normalizeBody } from './message-body';

describe('S24 message body rules', () => {
  it.each([
    ['hello', 'hello'],
    ['  hello  ', 'hello'],
    ['\n\thello world\n', 'hello world'],
    ['x'.repeat(CHAT_BODY_MAX), 'x'.repeat(CHAT_BODY_MAX)],
    ['😀'.repeat(CHAT_BODY_MAX), '😀'.repeat(CHAT_BODY_MAX)],
  ])('S24 AS-16: %j is accepted and stored trimmed', (raw, stored) => {
    expect(normalizeBody(raw)).toEqual({ ok: true, body: stored });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', ' \n\t '],
    ['4,001 characters', 'x'.repeat(CHAT_BODY_MAX + 1)],
    ['4,001 code points', '😀'.repeat(CHAT_BODY_MAX + 1)],
    ['not a string (number)', 5],
    ['not a string (null)', null],
    ['missing', undefined],
  ])('S24 AS-16: %s is refused', (_label, raw) => {
    expect(normalizeBody(raw)).toEqual({ ok: false });
  });

  it('S24 AS-16: trimming happens before the length check', () => {
    expect(normalizeBody(`  ${'x'.repeat(CHAT_BODY_MAX)}  `).ok).toBe(true);
  });
});
