import { describe, expect, it } from 'vitest';
import { loginHref, safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
  it.each(['/', '/account', '/account/security?tab=methods', '/orders/123#top', '/chat?product=1', '/checkout'])(
    'W01 AS-07: keeps the same-site path %s unchanged',
    (path) => {
      expect(safeReturnTo(path)).toBe(path);
    },
  );

  it.each([
    ['protocol-relative', '//evil.example'],
    ['backslash after slash', '/\\evil.example'],
    ['encoded protocol-relative', '/%2F%2Fevil.example'],
    ['encoded backslash', '/%5Cevil.example'],
    ['mixed encoded', '/%2fevil.example'],
    ['absolute url', 'https://evil.example/x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['empty', ''],
    ['no leading slash', 'account'],
    ['control character', '/ok\u0007bad'],
    ['encoded control character', '/ok%00bad'],
    ['newline', '/ok\nbad'],
    ['too long', `/${'a'.repeat(512)}`],
    ['malformed percent escape', '/%E0%A4%A'],
    ['inner backslash', '/a\\b'],
  ])('W01 AS-07: replaces %s with /', (_name, raw) => {
    expect(safeReturnTo(raw)).toBe('/');
  });

  it('W01 AS-07: accepts exactly 512 characters', () => {
    const path = `/${'a'.repeat(511)}`;
    expect(safeReturnTo(path)).toBe(path);
  });

  it('W01 AS-07: ignores a repeated parameter and missing values', () => {
    expect(safeReturnTo(['/a', '/b'])).toBe('/');
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
  });
});

describe('loginHref', () => {
  it('W01 AS-27: carries the validated path as returnTo', () => {
    expect(loginHref('/checkout')).toBe('/login?returnTo=%2Fcheckout');
    expect(loginHref('/account/security')).toBe('/login?returnTo=%2Faccount%2Fsecurity');
  });

  it('W01 AS-27: drops an unsafe or root path', () => {
    expect(loginHref('//evil.example')).toBe('/login');
    expect(loginHref('/')).toBe('/login');
  });
});
