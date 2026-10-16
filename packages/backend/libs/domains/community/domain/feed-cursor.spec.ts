import { createFeedCursorCodec } from './feed-cursor';

/** A fake signer: deterministic, secret-dependent, no `node:crypto`. */
const signer = (secret: string) => (data: string) => {
  let h = 5381;
  for (const ch of `${secret}|${data}`) h = (h * 33) ^ ch.charCodeAt(0);
  return (h >>> 0).toString(16).padStart(8, '0');
};

describe('feed and following keyset cursors', () => {
  const codec = createFeedCursorCodec(signer('s1'));
  const feedPos = {
    ms: 1_700_000_000_123,
    itemId: '1ef0a1b2c3d4e5f60718293a4b5c6d7e',
  };
  const followingPos = {
    followedAtMs: 1_700_000_000_456,
    accountId: 'shop:0190a1b2-c3d4-4e5f-8a1b-2c3d4e5f6071',
  };

  it('S26 AS-19: a feed cursor round-trips (ms, itemId) and is URL safe', () => {
    const token = codec.encodeFeed(feedPos);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(codec.decodeFeed(token)).toEqual(feedPos);
  });

  it('S26 AS-11: a following cursor round-trips (followed_at, account_id)', () => {
    const token = codec.encodeFollowing(followingPos);
    expect(codec.decodeFollowing(token)).toEqual(followingPos);
  });

  it('S26 AS-11: an account id with separators and unicode survives', () => {
    const pos = { followedAtMs: 0, accountId: 'user:a|b.c"é' };
    expect(codec.decodeFollowing(codec.encodeFollowing(pos))).toEqual(pos);
  });

  it('S26 AS-20: an edited feed cursor is invalid', () => {
    const token = codec.encodeFeed(feedPos);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify(['feed', feedPos.ms + 1, feedPos.itemId]),
    ).toString('base64url');
    expect(codec.decodeFeed(`${forged}.${sig}`)).toBeNull();
    expect(codec.decodeFeed(`${body}.deadbeef`)).toBeNull();
    expect(codec.decodeFeed(body)).toBeNull();
  });

  it('S26 AS-11: a cursor of the other list, or signed with another secret, is invalid', () => {
    const feed = codec.encodeFeed(feedPos);
    const following = codec.encodeFollowing(followingPos);
    expect(codec.decodeFollowing(feed)).toBeNull();
    expect(codec.decodeFeed(following)).toBeNull();
    const other = createFeedCursorCodec(signer('s2'));
    expect(other.decodeFeed(feed)).toBeNull();
  });

  it.each(['', '.', 'abc', 'a.b.c', '....', '%%%.%%%', 'e30.00000000'])(
    'S26 AS-20: malformed cursor %p is invalid, never an exception',
    (token) => {
      expect(codec.decodeFeed(token)).toBeNull();
      expect(codec.decodeFollowing(token)).toBeNull();
    },
  );

  it('S26 AS-20: a correctly signed body with the wrong shape is invalid', () => {
    const sign = signer('s1');
    const body = Buffer.from(JSON.stringify(['feed', 'x', 5])).toString(
      'base64url',
    );
    expect(codec.decodeFeed(`${body}.${sign(body)}`)).toBeNull();
    const bad = Buffer.from(JSON.stringify(['feed', -1, 'id'])).toString(
      'base64url',
    );
    expect(codec.decodeFeed(`${bad}.${sign(bad)}`)).toBeNull();
  });
});
