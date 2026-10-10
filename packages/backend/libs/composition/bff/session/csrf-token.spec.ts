import { randomBytes } from 'node:crypto';
import {
  issueCsrfToken,
  verifyCsrfRequest,
  verifyCsrfToken,
} from './csrf-token';

const key = randomBytes(32);
const otherKey = randomBytes(32);

describe('S48 AS-59 CSRF token (unit)', () => {
  it('S48 AS-59: a token verifies for the session it was issued for', () => {
    const token = issueCsrfToken(key, 'session-a');
    expect(verifyCsrfToken(key, 'session-a', token)).toBe(true);
  });

  it('S48 AS-59: tokens are random: two issues for one session differ and both verify', () => {
    const a = issueCsrfToken(key, 'session-a');
    const b = issueCsrfToken(key, 'session-a');
    expect(a).not.toBe(b);
    expect(verifyCsrfToken(key, 'session-a', b)).toBe(true);
  });

  it.each([
    [
      'another session',
      (t: string) => ({ token: t, session: 'session-b', k: key }),
    ],
    [
      'another key',
      (t: string) => ({ token: t, session: 'session-a', k: otherKey }),
    ],
    [
      'tampered mac',
      (t: string) => ({
        token: t.slice(0, -2) + 'AA',
        session: 'session-a',
        k: key,
      }),
    ],
    [
      'tampered random part',
      (t: string) => ({
        token: 'AAAA' + t.slice(4),
        session: 'session-a',
        k: key,
      }),
    ],
    ['empty', () => ({ token: '', session: 'session-a', k: key })],
    ['no separator', () => ({ token: 'abcdef', session: 'session-a', k: key })],
    [
      'extra part',
      (t: string) => ({ token: `${t}.x`, session: 'session-a', k: key }),
    ],
    [
      'not base64url',
      () => ({ token: '***.***', session: 'session-a', k: key }),
    ],
  ])('S48 AS-59: rejects %s', (_name, mutate) => {
    const { token, session, k } = mutate(issueCsrfToken(key, 'session-a'));
    expect(verifyCsrfToken(k, session, token)).toBe(false);
  });

  it('S48 AS-59: the request check needs header and cookie to be equal and valid for the session', () => {
    const token = issueCsrfToken(key, 'session-a');
    expect(verifyCsrfRequest(key, 'session-a', token, token)).toBe(true);
    expect(verifyCsrfRequest(key, 'session-a', undefined, token)).toBe(false);
    expect(verifyCsrfRequest(key, 'session-a', token, undefined)).toBe(false);
    const other = issueCsrfToken(key, 'session-a');
    expect(verifyCsrfRequest(key, 'session-a', other, token)).toBe(false);
    const foreign = issueCsrfToken(key, 'session-b');
    expect(verifyCsrfRequest(key, 'session-a', foreign, foreign)).toBe(false);
    expect(verifyCsrfRequest(key, 'session-a', '', '')).toBe(false);
  });
});
