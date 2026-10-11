/**
 * Static security headers (contracts/security-headers.md). One module feeds `next.config.ts` `headers()`, `robots.ts` and the
 * tests, so the no-store paths and the robots disallow list cannot drift apart. The CSP itself is per request (`csp.ts`, `proxy.ts`).
 */

export type Header = { key: string; value: string };
export type HeaderRule = { source: string; headers: Header[] };

export const GENERAL_REFERRER_POLICY = 'strict-origin-when-cross-origin';

/** Pages whose URL carries a secret (reset token, invite token): the address must never leave in a Referer header. */
export const noReferrerPaths = ['/reset-password', '/invites/:path*'];

/** Signed-in areas: never cached by a browser or an intermediary (Back after sign-out must not show them). */
export const noStorePaths = ['/dashboard/', '/account/', '/checkout/', '/cart', '/chat', '/admin/', '/invites/', '/api/'];

export function staticSecurityHeaders(production: boolean): Header[] {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: GENERAL_REFERRER_POLICY },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), payment=(), geolocation=(self)' },
    // Not `same-origin`: payment 3-D Secure windows must keep working.
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    ...(production ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
  ];
}

/** `/dashboard/` -> `/dashboard/:path*`; `/cart` -> `/cart` and `/cart/:path*`. */
function noStoreSources(): string[] {
  return noStorePaths.flatMap((path) => (path.endsWith('/') ? [`${path}:path*`] : [path, `${path}/:path*`]));
}

/** Rules for `next.config.ts` `headers()`: the general Referrer-Policy rule excludes `noReferrerPaths` by its source pattern. */
export function securityHeaderRules(production: boolean): HeaderRule[] {
  const all = staticSecurityHeaders(production);
  const withoutReferrer = all.filter((header) => header.key !== 'Referrer-Policy');
  return [
    { source: '/(.*)', headers: withoutReferrer },
    // Every path except the no-referrer ones gets the general policy.
    { source: '/((?!reset-password|invites(?:/|$)).*)', headers: [{ key: 'Referrer-Policy', value: GENERAL_REFERRER_POLICY }] },
    ...noReferrerPaths.map((source) => ({ source, headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] })),
    ...noStoreSources().map((source) => ({ source, headers: [{ key: 'Cache-Control', value: 'no-store' }] })),
  ];
}
