import { describe, expect, it } from 'vitest';
import { parseMoneyInput } from './money-input';

/** Added after a mutation run (scripts/aiqa/tracks/mutation): pins the edges of the amount parser that no other test guarded. */
describe('W04 AS-35 parseMoneyInput edges (mutation survivors)', () => {
  it('a minus sign anywhere but the start is a format error, not "negative"', () => {
    expect(parseMoneyInput('5-3', 2)).toEqual({ ok: false, reason: 'format' });
    expect(parseMoneyInput('1.5-', 2)).toEqual({ ok: false, reason: 'format' });
  });

  it('a minus, then spaces, then a digit is negative; a lone minus is a format error', () => {
    expect(parseMoneyInput('- 5', 2)).toEqual({ ok: false, reason: 'negative' });
    expect(parseMoneyInput('-  0,50', 2)).toEqual({ ok: false, reason: 'negative' });
    expect(parseMoneyInput('-', 2)).toEqual({ ok: false, reason: 'format' });
    expect(parseMoneyInput('-a', 2)).toEqual({ ok: false, reason: 'format' });
  });

  it('many leading zeros do not count towards the size limit', () => {
    expect(parseMoneyInput('0000000000000000001', 0)).toEqual({ ok: true, minor: 1 });
    expect(parseMoneyInput('00000000000000000012.50', 2)).toEqual({ ok: true, minor: 1250 });
  });

  it('16 digits that fit are accepted; 16 digits above the safe integer are too large', () => {
    expect(parseMoneyInput('1000000000000000', 0)).toEqual({ ok: true, minor: 1_000_000_000_000_000 });
    expect(parseMoneyInput('9007199254740991', 0)).toEqual({ ok: true, minor: Number.MAX_SAFE_INTEGER });
    expect(parseMoneyInput('9007199254740992', 0)).toEqual({ ok: false, reason: 'too_large' });
    expect(parseMoneyInput('9007199254740993', 0)).toEqual({ ok: false, reason: 'too_large' });
  });
});
