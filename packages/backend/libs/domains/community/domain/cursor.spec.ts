import { createCursorCodec, type CursorKind } from './cursor';

/** A fake signer: deterministic, secret-dependent, no `node:crypto`. */
const signer = (secret: string) => (data: string) => {
  let h = 5381;
  for (const ch of `${secret}|${data}`) h = (h * 33) ^ ch.charCodeAt(0);
  return (h >>> 0).toString(16).padStart(8, '0');
};

describe('opaque keyset cursors', () => {
  const codec = createCursorCodec(signer('s1'));

  it.each<[CursorKind, string, string]>([
    ['hot', 'board-1:hot', '0190a1b2c3d4|1.5'],
    ['top', 'board-1:top:week', 'abc|7'],
    ['new', 'board-1:new', '202610|0190a1b2'],
    ['best', 'post-1:best', 'x'],
    ['old', 'post-1:old', '3|path.with.dots'],
    ['replies', 'comment-1', 'p'],
  ])(
    'S25 AS-35: a %s cursor round-trips its position for scope %s',
    (kind, scope, position) => {
      const token = codec.encode({ kind, scope, position });
      expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(codec.decode(token, { kind, scope })).toBe(position);
    },
  );

  it('S25 AS-20: a position with separators and unicode survives', () => {
    const position = 'a|b|c.é€|"quoted"';
    const token = codec.encode({ kind: 'new', scope: 's|c', position });
    expect(codec.decode(token, { kind: 'new', scope: 's|c' })).toBe(position);
  });

  it.each([
    ['not base64', '%%%'],
    ['empty', ''],
    ['no signature', 'e1tdfQ'],
    ['truncated', 'abc.'],
  ])('S25 AS-39: a malformed cursor (%s) is invalid', (_n, token) => {
    expect(codec.decode(token, { kind: 'hot', scope: 'b' })).toBeNull();
  });

  it('S25 AS-20: a tampered position is invalid', () => {
    const token = codec.encode({ kind: 'hot', scope: 'b', position: 'p1' });
    const other = codec.encode({ kind: 'hot', scope: 'b', position: 'p2' });
    const forged = `${other.split('.')[0]}.${token.split('.')[1]}`;
    expect(codec.decode(forged, { kind: 'hot', scope: 'b' })).toBeNull();
  });

  it('S25 AS-39: a cursor issued for another scope or kind is invalid', () => {
    const token = codec.encode({
      kind: 'hot',
      scope: 'board-1:hot',
      position: 'p',
    });
    expect(
      codec.decode(token, { kind: 'hot', scope: 'board-2:hot' }),
    ).toBeNull();
    expect(
      codec.decode(token, { kind: 'top', scope: 'board-1:hot' }),
    ).toBeNull();
  });

  it('S25 AS-39: a cursor signed with another secret is invalid', () => {
    const token = createCursorCodec(signer('s2')).encode({
      kind: 'hot',
      scope: 'b',
      position: 'p',
    });
    expect(codec.decode(token, { kind: 'hot', scope: 'b' })).toBeNull();
  });
});
