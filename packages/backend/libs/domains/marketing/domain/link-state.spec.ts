import { FakeClock } from '@app/common/core/clock';
import {
  canTransition,
  isExpired,
  linkStateOf,
  purgeAtEpoch,
  type LinkStateInput,
} from './link-state';

const T = new Date('2026-03-01T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms).toISOString();

describe('S37 AS-65: link state is decided by the injected clock (AS-28 boundary, AS-53 transitions)', () => {
  it.each([
    ['one ms before', -1, false],
    ['exactly at expiresAt', 0, true],
    ['one ms after', 1, true],
    ['ten seconds after', 10_000, true],
  ])('expiry boundary: %s', (_name, offsetMs, expired) => {
    const clock = new FakeClock(new Date(T.getTime() + offsetMs));
    expect(isExpired({ expiresAt: T.toISOString() }, clock.now())).toBe(
      expired,
    );
  });

  it('a link without expiry never expires', () => {
    expect(isExpired({ expiresAt: null }, new Date('2999-01-01'))).toBe(false);
  });

  it('moving the injected clock moves the state', () => {
    const clock = new FakeClock(T);
    const link: LinkStateInput = {
      status: 'ACTIVE',
      expiresAt: at(9_000),
    };
    expect(linkStateOf(link, clock.now())).toBe('ACTIVE');
    clock.advance(9_000);
    expect(linkStateOf(link, clock.now())).toBe('EXPIRED');
  });

  it.each([
    ['ACTIVE', null, 'ACTIVE'],
    ['ACTIVE', at(-1), 'EXPIRED'],
    ['DISABLED', null, 'DISABLED'],
    ['DISABLED', at(-1), 'DISABLED'],
    [undefined, null, 'ACTIVE'],
  ] as const)(
    'state of %s, expiresAt %s → %s',
    (status, expiresAt, expected) => {
      expect(linkStateOf({ status, expiresAt }, T)).toBe(expected);
    },
  );

  it.each([
    ['ACTIVE', 'change', true],
    ['ACTIVE', 'disable', true],
    ['EXPIRED', 'change', false],
    ['EXPIRED', 'disable', false],
    ['DISABLED', 'change', false],
    ['DISABLED', 'disable', false],
  ] as const)('%s × %s allowed: %s', (state, action, allowed) => {
    expect(canTransition(state, action)).toBe(allowed);
  });

  it('retention: purge 13 months after expiry or disable, none when neither', () => {
    expect(
      purgeAtEpoch({ expiresAt: null, disabledAt: undefined }),
    ).toBeUndefined();
    const expiry = purgeAtEpoch({ expiresAt: '2026-03-01T00:00:00.000Z' });
    const disabled = purgeAtEpoch({
      expiresAt: null,
      disabledAt: '2026-03-01T00:00:00.000Z',
    });
    expect(expiry).toBe(Date.parse('2027-04-01T00:00:00.000Z') / 1000);
    expect(disabled).toBe(expiry);
  });
});
