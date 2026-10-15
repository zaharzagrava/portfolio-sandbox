import { describe, expect, it } from 'vitest';
import { noReferrerPaths, noStorePaths, securityHeaderRules, staticSecurityHeaders } from './headers';

const headerValue = (name: string, production = true) =>
  staticSecurityHeaders(production).find((header) => header.key.toLowerCase() === name.toLowerCase())?.value;

describe('W07 security headers (lib/security/headers.ts)', () => {
  it.each([
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Permissions-Policy', 'camera=(), microphone=(), payment=(), geolocation=(self)'],
    ['Cross-Origin-Opener-Policy', 'same-origin-allow-popups'],
    ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains'],
  ])('W07 AS-19: %s is %s in production', (name, value) => {
    expect(headerValue(name)).toBe(value);
  });

  it('W07 AS-19: Strict-Transport-Security is production only', () => {
    expect(headerValue('Strict-Transport-Security', false)).toBeUndefined();
    expect(headerValue('X-Frame-Options', false)).toBe('DENY');
  });

  it('W07 AS-19: no header is repeated', () => {
    const names = staticSecurityHeaders(true).map((header) => header.key.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('W07 AS-19: no-referrer paths are exactly /reset-password and /invites/*', () => {
    expect(noReferrerPaths).toEqual(['/reset-password', '/invites/:path*']);
  });

  it('W07 AS-19: the general Referrer-Policy rule excludes the no-referrer paths, so one effective value results', () => {
    const rules = securityHeaderRules(true);
    const effective = (path: string) =>
      rules
        .filter((rule) => matchesSource(rule.source, path))
        .flatMap((rule) => rule.headers.filter((header) => header.key === 'Referrer-Policy').map((header) => header.value));
    expect(effective('/')).toEqual(['strict-origin-when-cross-origin']);
    expect(effective('/products/abc')).toEqual(['strict-origin-when-cross-origin']);
    expect(effective('/reset-password')).toEqual(['no-referrer']);
    expect(effective('/invites/tok123')).toEqual(['no-referrer']);
    expect(effective('/invites/tok123/accept')).toEqual(['no-referrer']);
  });

  it('W01 AS-64: the reset page answers Referrer-Policy: no-referrer and nothing else for that header', () => {
    const values = securityHeaderRules(true)
      .filter((rule) => matchesSource(rule.source, '/reset-password'))
      .flatMap((rule) => rule.headers.filter((header) => header.key === 'Referrer-Policy').map((header) => header.value));
    expect(values).toEqual(['no-referrer']);
  });

  it('W07 AS-20: no-store paths cover every signed-in area', () => {
    for (const path of ['/dashboard/orders', '/orders', '/orders/abc', '/account/security', '/checkout/pay/x', '/cart', '/chat', '/admin/feature-flags', '/invites/tok', '/api/orders']) {
      expect(securityHeaderRules(true).some((rule) => matchesSource(rule.source, path) && rule.headers.some((h) => h.key === 'Cache-Control' && h.value === 'no-store')), path).toBe(true);
    }
    for (const path of ['/', '/privacy', '/terms', '/products/abc', '/search', '/developers/docs']) {
      expect(securityHeaderRules(true).some((rule) => matchesSource(rule.source, path) && rule.headers.some((h) => h.key === 'Cache-Control')), path).toBe(false);
    }
  });

  it('W07 AS-34: private areas send noindex, public pages do not', () => {
    const noindex = (path: string) => securityHeaderRules(true).some((rule) => matchesSource(rule.source, path) && rule.headers.some((h) => h.key === 'X-Robots-Tag' && h.value === 'noindex'));
    for (const path of ['/dashboard/orders', '/account/security', '/checkout/pay/x', '/cart', '/chat', '/admin/feature-flags', '/invites/tok', '/api/orders']) expect(noindex(path), path).toBe(true);
    for (const path of ['/', '/privacy', '/terms', '/products/abc', '/search', '/developers/docs']) expect(noindex(path), path).toBe(false);
  });

  it('W07 AS-20: noStorePaths equal the robots disallow list (plus /api/)', () => {
    expect(noStorePaths).toEqual(['/dashboard/', '/account/', '/checkout/', '/cart', '/orders', '/chat', '/admin/', '/invites/', '/api/']);
  });
});

/** Minimal matcher for the `source` patterns used here: parenthesised regex groups, literal paths and `:path*` suffixes. */
function matchesSource(source: string, path: string): boolean {
  return new RegExp(`^${source.replace(/\/:path\*/g, '(?:/.*)?')}$`).test(path);
}
