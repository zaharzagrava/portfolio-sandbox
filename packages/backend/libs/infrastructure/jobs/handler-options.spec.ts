import {
  DEFAULT_HANDLER_OPTIONS,
  resolveHandlerOptions,
  validateJobTypeName,
} from './handler-options';

describe('job type names (S49)', () => {
  it.each([
    'auction.close',
    'platform.purge-idempotency-keys',
    'jobs.noop',
    'a.b',
    'orders.send-2fa-code',
  ])('S49 AS-92: accepts %s', (name) => {
    expect(validateJobTypeName(name)).toBe(true);
  });

  it.each([
    'noop',
    'Auction.close',
    'auction.Close',
    'auction..close',
    'auction.close.again',
    '.close',
    'auction.',
    'auction.close_now',
    'auction. close',
    '',
    'auction.-close',
  ])('S49 AS-92: rejects "%s"', (name) => {
    expect(validateJobTypeName(name)).toBe(false);
  });
});

describe('handler options (S49)', () => {
  it('S49 AS-92: applies explicit defaults', () => {
    expect(resolveHandlerOptions('a.b', {})).toEqual({
      type: 'a.b',
      leaseMs: 60_000,
      concurrency: 10,
      fleetConcurrency: undefined,
      maxRuntimeMs: 900_000,
    });
    expect(DEFAULT_HANDLER_OPTIONS.maxRuntimeMs).toBe(900_000);
  });

  it.each([
    [{ leaseMs: 5_000 }, true],
    [{ leaseMs: 14_400_000, maxRuntimeMs: 14_400_000 }, true],
    [{ leaseMs: 4_999 }, false],
    [{ leaseMs: 14_400_001 }, false],
    [{ concurrency: 1 }, true],
    [{ concurrency: 0 }, false],
    [{ concurrency: 1.5 }, false],
    [{ fleetConcurrency: 1 }, true],
    [{ fleetConcurrency: 0 }, false],
    [{ leaseMs: 30_000, maxRuntimeMs: 30_000 }, true],
    [{ leaseMs: 30_000, maxRuntimeMs: 29_999 }, false],
    [{ maxRuntimeMs: 30_000 }, false],
    [{ maxRuntimeMs: 60_000 }, true],
  ])('S49 AS-92: options %j valid=%s', (options, valid) => {
    const run = () => resolveHandlerOptions('a.b', options);
    if (valid) expect(run).not.toThrow();
    else expect(run).toThrow(/a\.b/);
  });

  it('S49 AS-92: rejects a bad type name', () => {
    expect(() => resolveHandlerOptions('Bad Name', {})).toThrow(/Bad Name/);
  });
});
