import { idempotencyKey } from './idempotency-key';
import { InvalidIdempotencyKeyError } from './idempotency-errors';

describe('idempotencyKey', () => {
  it('S55 AS-20: keys of two shops for the same document differ, and parts cannot collide', () => {
    expect(idempotencyKey('shop-1', 'doc-9')).not.toBe(
      idempotencyKey('shop-2', 'doc-9'),
    );
    expect(idempotencyKey('a#b', 'c')).not.toBe(idempotencyKey('a', 'b#c'));
    expect(idempotencyKey('shop-1', 'doc-9')).toBe(
      idempotencyKey('shop-1', 'doc-9'),
    );
  });

  it.each([
    ['no part', [] as string[]],
    ['an empty part', ['shop', '']],
    ['an empty key', ['']],
    ['513 characters', ['x'.repeat(513)]],
    ['a control character', ['shop', 'a\u0007b']],
  ])(
    'S55 AS-21: %s is rejected with InvalidIdempotencyKeyError',
    (_name, parts) => {
      expect(() => idempotencyKey(...parts)).toThrow(
        InvalidIdempotencyKeyError,
      );
    },
  );

  it('S55 AS-21: exactly 512 characters is accepted', () => {
    expect(idempotencyKey('x'.repeat(512))).toHaveLength(512);
  });
});
