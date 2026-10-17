import { assertValidOptions } from './idempotency-options';
import { InvalidIdempotencyOptionsError } from './idempotency-errors';

describe('idempotency options', () => {
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['below the function timeout', 29_999],
    ['not a number', Number.NaN],
  ])('S55 AS-25: a lease of %s is rejected', (_name, leaseMs) => {
    expect(() => assertValidOptions({ leaseMs }, 30_000)).toThrow(
      InvalidIdempotencyOptionsError,
    );
  });

  it('S55 AS-25: a lease equal to the function timeout is accepted', () => {
    expect(() => assertValidOptions({ leaseMs: 30_000 }, 30_000)).not.toThrow();
  });
});
