import { RetryOptionsError, resolveMaxAttempts } from './retry-options';

describe('retry options (U-RETO)', () => {
  it.each([
    [{}, 3],
    [{ profile: 'sync' as const }, 3],
    [{ profile: 'background' as const }, 6],
    [{ maxAttempts: 1 }, 1],
    [{ maxAttempts: 2 }, 2],
    [{ maxAttempts: 3 }, 3],
    [{ profile: 'background' as const, maxAttempts: 5 }, 5],
    [{ profile: 'background' as const, maxAttempts: 6 }, 6],
  ])('S54 AS-89: %j resolves to %d attempts', (options, expected) => {
    expect(resolveMaxAttempts(options)).toBe(expected);
  });

  it.each([
    [{ maxAttempts: 4 }],
    [{ maxAttempts: 5 }],
    [{ profile: 'sync' as const, maxAttempts: 5 }],
    [{ profile: 'background' as const, maxAttempts: 7 }],
    [{ maxAttempts: 0 }],
    [{ maxAttempts: -1 }],
    [{ maxAttempts: 1.5 }],
    [{ maxAttempts: Number.NaN }],
  ])('S54 AS-89: %j is rejected before any network call', (options) => {
    expect(() => resolveMaxAttempts(options)).toThrow(RetryOptionsError);
  });
});
