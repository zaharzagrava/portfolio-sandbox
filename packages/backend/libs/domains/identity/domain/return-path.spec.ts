import { parseReturnPath } from './return-path';

describe('S02 AS-34: return path grammar', () => {
  it.each([
    '/',
    '/orders',
    '/orders/42?tab=open&x=1',
    '/a/b#frag',
    '/caf%C3%A9',
    `/${'a'.repeat(511)}`,
  ])('accepts %s unchanged', (path) => {
    expect(parseReturnPath(path)).toBe(path);
  });

  it.each([
    ['empty', ''],
    ['no leading slash', 'orders'],
    ['double slash', '//evil.example'],
    ['absolute url', 'https://evil.example/'],
    ['scheme-relative via backslash', '/\\evil.example'],
    ['backslash anywhere', '/a\\b'],
    ['javascript url', 'javascript:alert(1)'],
    ['encoded double slash', '/%2f%2fevil.example'],
    ['mixed-case encoded double slash', '/%2F/evil.example'],
    ['encoded slash first', '/%2fevil'],
    ['encoded backslash', '/%5cevil.example'],
    ['encoded backslash upper', '/%5Cevil.example'],
    ['newline', '/a\nb'],
    ['carriage return', '/a\rb'],
    ['nul', '/a\u0000b'],
    ['encoded control char', '/a%0d%0aSet-Cookie:x'],
    ['too long', `/${'a'.repeat(512)}`],
    ['malformed percent escape', '/%zz'],
    ['leading space', ' /ok'],
  ])('rejects %s', (_name, path) => {
    expect(parseReturnPath(path)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseReturnPath(undefined as unknown as string)).toBeNull();
    expect(parseReturnPath(42 as unknown as string)).toBeNull();
  });
});
