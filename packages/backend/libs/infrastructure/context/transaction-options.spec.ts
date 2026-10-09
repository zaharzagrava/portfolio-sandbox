import {
  validateTimeoutMs,
  resolveTransactionOptions,
} from './transaction-options';

describe('transaction options', () => {
  it.each([[0], [-1], [NaN], [1.5], ['1; drop table x'], [700000], [Infinity]])(
    'S54 AS-38: rejects timeout %p',
    (value) => {
      expect(() => validateTimeoutMs('lockTimeoutMs', value as number)).toThrow(
        RangeError,
      );
    },
  );

  it.each([[1], [600000], [250]])('S54 AS-38: accepts timeout %p', (value) => {
    expect(validateTimeoutMs('lockTimeoutMs', value)).toBe(value);
  });

  it('S54 AS-38: resolves defaults (join, 1 attempt) and bounds maxAttempts to 1..3', () => {
    expect(resolveTransactionOptions({})).toMatchObject({
      propagation: 'join',
    });
    expect(() => resolveTransactionOptions({ maxAttempts: 4 })).toThrow(
      RangeError,
    );
    expect(() => resolveTransactionOptions({ maxAttempts: 0 })).toThrow(
      RangeError,
    );
    expect(resolveTransactionOptions({ maxAttempts: 3 }).maxAttempts).toBe(3);
    expect(() =>
      resolveTransactionOptions({ propagation: 'nested' as never }),
    ).toThrow(RangeError);
  });
});
