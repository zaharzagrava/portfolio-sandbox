import {
  callerAllowed,
  checkMintRequest,
  DEFAULT_SERVICE_TOKEN_TTL_SEC,
  MAX_SERVICE_TOKEN_TTL_SEC,
} from './service-token-policy';

const AUDIENCES = ['core', 'worker'];

describe('Service token mint policy', () => {
  const cases: Array<
    [string, { caller: string; audience: string; ttlSec?: number }, unknown]
  > = [
    [
      'default TTL is 60 s',
      { caller: 'worker', audience: 'core' },
      { ok: true, ttlSec: 60 },
    ],
    [
      'a TTL of 300 s is accepted',
      { caller: 'worker', audience: 'core', ttlSec: 300 },
      { ok: true, ttlSec: 300 },
    ],
    [
      'a TTL of 301 s is rejected',
      { caller: 'worker', audience: 'core', ttlSec: 301 },
      { ok: false, reason: 'ttl' },
    ],
    [
      'a TTL of 0 is rejected',
      { caller: 'worker', audience: 'core', ttlSec: 0 },
      { ok: false, reason: 'ttl' },
    ],
    [
      'a fractional or negative TTL is rejected',
      { caller: 'worker', audience: 'core', ttlSec: -5 },
      { ok: false, reason: 'ttl' },
    ],
    [
      'a fractional TTL is rejected',
      { caller: 'worker', audience: 'core', ttlSec: 1.5 },
      { ok: false, reason: 'ttl' },
    ],
    [
      'an audience outside the allowlist is rejected',
      { caller: 'worker', audience: 'billing-api' },
      { ok: false, reason: 'audience' },
    ],
    [
      'an empty caller is rejected',
      { caller: '', audience: 'core' },
      { ok: false, reason: 'caller' },
    ],
    [
      'a blank caller is rejected',
      { caller: '   ', audience: 'core' },
      { ok: false, reason: 'caller' },
    ],
    [
      'a caller that would forge another subject is rejected',
      { caller: 'svc:worker', audience: 'core' },
      { ok: false, reason: 'caller' },
    ],
  ];

  it.each(cases)('S01 AS-71: %s', (_name, input, expected) => {
    expect(checkMintRequest(input, AUDIENCES)).toEqual(expected);
  });

  it('S01 AS-71: the default is 60 s and the maximum 300 s', () => {
    expect([DEFAULT_SERVICE_TOKEN_TTL_SEC, MAX_SERVICE_TOKEN_TTL_SEC]).toEqual([
      60, 300,
    ]);
  });

  it.each([
    ['worker', ['worker', 'billing'], true],
    ['billing', ['worker', 'billing'], true],
    ['projector', ['worker', 'billing'], false],
    ['worker', [], false],
    ['Worker', ['worker'], false],
  ])(
    'S01 AS-71: caller %s against %j is allowed: %s',
    (caller, allowed, expected) => {
      expect(callerAllowed(caller, allowed)).toBe(expected);
    },
  );
});
