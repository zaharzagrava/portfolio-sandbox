import {
  assertTransition,
  deriveKeyStatus,
  KeyState,
  KeyStatus,
} from './key-status';

const NOW = new Date('2026-10-06T12:00:00Z');
const past = new Date('2026-10-06T11:59:59Z');
const future = new Date('2026-10-06T12:00:01Z');

const base: KeyState = {
  revokedAt: null,
  expiresAt: null,
  successorId: null,
};

describe('S42 key status (FR-005)', () => {
  it.each<[string, KeyState, KeyStatus]>([
    ['plain key', base, 'active'],
    ['future expiry only', { ...base, expiresAt: future }, 'active'],
    [
      'successor and future expiry',
      { ...base, expiresAt: future, successorId: 'k2' },
      'rotating',
    ],
    ['successor without expiry', { ...base, successorId: 'k2' }, 'rotating'],
    ['expiry exactly now is expired', { ...base, expiresAt: NOW }, 'expired'],
    ['past expiry', { ...base, expiresAt: past }, 'expired'],
    [
      'past expiry with successor stays expired',
      { ...base, expiresAt: past, successorId: 'k2' },
      'expired',
    ],
    [
      'revoked wins over expired',
      { ...base, revokedAt: past, expiresAt: past },
      'revoked',
    ],
    [
      'revoked wins over rotating',
      { ...base, revokedAt: past, successorId: 'k2' },
      'revoked',
    ],
  ])('derives %s', (_name, state, expected) => {
    expect(deriveKeyStatus(state, NOW)).toBe(expected);
  });

  it.each<[KeyStatus, 'rotate' | 'revoke', string | null]>([
    ['active', 'rotate', null],
    ['active', 'revoke', null],
    ['rotating', 'revoke', null],
    ['rotating', 'rotate', 'key_already_rotating'],
    ['revoked', 'rotate', 'key_revoked'],
    ['expired', 'rotate', 'key_expired'],
    ['expired', 'revoke', null],
    ['revoked', 'revoke', null],
  ])('%s + %s → %s', (status, action, code) => {
    if (code === null) {
      expect(() => assertTransition(status, action)).not.toThrow();
    } else {
      expect(() => assertTransition(status, action)).toThrow(
        expect.objectContaining({ code }),
      );
    }
  });
});
