import { authorHandle } from './author-handle';

const USER = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '0199a1b2-c3d4-7e5f-8a9b-ffffffffffff';
const STREAM = '0199ffff-0000-7000-8000-aaaaaaaaaaaa';

describe('authorHandle', () => {
  it('S23 AS-25: is deterministic for one (user, stream)', () => {
    expect(authorHandle(USER, STREAM)).toBe(authorHandle(USER, STREAM));
  });

  it('S23 AS-25: differs between streams for the same user', () => {
    expect(authorHandle(USER, STREAM)).not.toBe(
      authorHandle(USER, '0199ffff-0000-7000-8000-bbbbbbbbbbbb'),
    );
  });

  it('S23 AS-25: differs between users in one stream', () => {
    expect(authorHandle(USER, STREAM)).not.toBe(authorHandle(OTHER, STREAM));
  });

  it('S23 AS-25: has the fixed shape and echoes nothing of its input', () => {
    const handle = authorHandle(USER, STREAM);
    expect(handle).toMatch(/^viewer-[a-z]{8}$/);
    for (const piece of [USER, STREAM, 'mail', '@'])
      expect(handle).not.toContain(piece);
    for (const part of USER.split('-')) expect(handle).not.toContain(part);
  });
});
