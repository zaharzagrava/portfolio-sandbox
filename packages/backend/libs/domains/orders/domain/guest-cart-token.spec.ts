import { createHmac } from 'node:crypto';
import {
  issueGuestToken,
  userCartId,
  verifyGuestToken,
} from './guest-cart-token';

const SECRET = 'a-cart-secret-that-is-at-least-32-bytes-long';
const sign = (value: string, secret = SECRET) =>
  createHmac('sha256', secret).update(value).digest('base64url');

describe('S10 AS-11: guest cart token', () => {
  const { cartId, token } = issueGuestToken(SECRET);

  it('S10 AS-11: a token we issued verifies and names a guest:<uuid> cart', () => {
    expect(cartId).toMatch(
      /^guest:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(verifyGuestToken(SECRET, token)).toBe(cartId);
  });

  const uuid = '3f2b1c4e-7a9d-4e5f-8b6a-1c2d3e4f5a6b';
  it.each<[string, string | undefined | null]>([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['no dot at all (lastIndexOf = -1)', `guest:${uuid}`],
    ['only a dot', '.'],
    [
      'signature of another secret',
      `guest:${uuid}.${sign(`guest:${uuid}`, 'other-secret-other-secret-other-secret')}`,
    ],
    [
      'signature of another cart id',
      `guest:${uuid}.${sign('guest:00000000-0000-4000-8000-000000000000')}`,
    ],
    [
      'truncated signature (length differs)',
      `guest:${uuid}.${sign(`guest:${uuid}`).slice(0, 10)}`,
    ],
    ['empty signature', `guest:${uuid}.`],
    [
      'user: prefix with a valid signature',
      `user:${uuid}.${sign(`user:${uuid}`)}`,
    ],
    ['valid signature of a non-uuid id', `guest:abc.${sign('guest:abc')}`],
    ['signature with a multibyte tail', `guest:${uuid}.${'é'.repeat(20)}`],
    ['token with an extra dot segment', `${token}.extra`],
  ])('S10 AS-11: %s is refused without throwing', (_name, value) => {
    expect(() => verifyGuestToken(SECRET, value)).not.toThrow();
    expect(verifyGuestToken(SECRET, value)).toBeNull();
  });

  it('S10 AS-11: two issued tokens differ and each verifies only under its own secret', () => {
    const other = issueGuestToken(SECRET);
    expect(other.cartId).not.toBe(cartId);
    expect(
      verifyGuestToken('another-secret-another-secret-123456', other.token),
    ).toBeNull();
  });

  it('S10 AS-11: user carts are named user:<id>', () => {
    expect(userCartId('u1')).toBe('user:u1');
  });
});
