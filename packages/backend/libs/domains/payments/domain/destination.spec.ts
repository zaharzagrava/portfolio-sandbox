import {
  effectiveFromFor,
  isCooling,
  maskDestination,
  validateDestination,
} from './destination';

describe('destination format and masking (S15 AS-38)', () => {
  it.each([
    ['acct_12345678', true],
    ['acct_' + 'A'.repeat(64), true],
    ['acct_1234567', false],
    ['acct_' + 'a'.repeat(65), false],
    ['acct_1234-5678', false],
    ['acct_12345678\n', false],
    ['ACCT_12345678', false],
    ['xacct_12345678', false],
    ['acct_12345678 ', false],
    ['', false],
    ['  ', false],
    ['acct_é2345678', false],
    // the three scripted-double ids of S15.R-27 are accepted as they are; near misses are not
    ['acct_test_ok', true],
    ['acct_test_reject', true],
    ['acct_test_timeout', true],
    ['acct_test_okay', false],
    ['acct_test_ok\n', false],
    ['xacct_test_ok', false],
  ])('S15 AS-38: %j is %s', (value, valid) => {
    expect(validateDestination(value)).toBe(valid);
  });

  it('S15 AS-38: a non-string is invalid', () => {
    expect(validateDestination(undefined as never)).toBe(false);
    expect(validateDestination(42 as never)).toBe(false);
  });

  it('S15 AS-38: the mask shows the first 5 and the last 3 characters only', () => {
    expect(maskDestination('acct_1AbCdEfGh')).toBe('acct_…fGh');
    const masked = maskDestination('acct_SECRETSECRET1234');
    expect(masked).toBe('acct_…234');
    expect(masked).not.toContain('SECRET');
  });
});

describe('effective-from rule (S15 AS-39)', () => {
  const COOLING = 48 * 3_600_000;
  const T = new Date('2026-10-05T10:00:00Z');

  it('S15 AS-39: a first destination counts at once', () => {
    expect(effectiveFromFor(null, 'acct_12345678', T, COOLING)).toEqual(T);
  });

  it('S15 AS-39: a different value counts after the cooling period', () => {
    expect(
      effectiveFromFor('acct_12345678', 'acct_87654321', T, COOLING),
    ).toEqual(new Date(T.getTime() + COOLING));
  });

  it('S15 AS-39: the same value writes nothing', () => {
    expect(
      effectiveFromFor('acct_12345678', 'acct_12345678', T, COOLING),
    ).toBeNull();
  });

  it('S15 AS-39: a zero cooling period makes a change count at once', () => {
    expect(effectiveFromFor('acct_12345678', 'acct_87654321', T, 0)).toEqual(T);
  });

  it('S15 AS-39: cooling is over exactly at T+48h, not at T+47h59m', () => {
    const effective = new Date(T.getTime() + COOLING);
    expect(isCooling(effective, new Date(T.getTime() + COOLING - 60_000))).toBe(
      true,
    );
    expect(isCooling(effective, new Date(T.getTime() + COOLING))).toBe(false);
    expect(isCooling(effective, new Date(T.getTime() + COOLING + 1))).toBe(
      false,
    );
  });
});
