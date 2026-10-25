import { NextResponse, type NextRequest } from 'next/server';
import { parseConfig } from '@/lib/config-parse';
import { buildCsp, CSP_REPORT_GROUP, CSP_REPORT_PATH, generateNonce } from '@/lib/security/csp';

// Parsed once per process. `lib/config.ts` is `server-only` and cannot be imported here.
const appConfig = parseConfig(process.env);

function hasBrokenPercent(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return false;
  } catch {
    return true;
  }
}

/**
 * Per-response nonce policy (Next.js "Content Security Policy" guide). This hook decides nothing about access, status or
 * redirects: authorization lives in the pages and the API (constitution VI.5).
 */
export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const policy = buildCsp({
    nonce,
    pathname: request.nextUrl.pathname,
    isDev: appConfig.isDev,
    hosts: {
      mediaHosts: appConfig.mediaHosts,
      videoHosts: appConfig.videoHosts,
      mapTileHost: appConfig.mapTileHost,
      paymentProviderHosts: appConfig.paymentProviderHosts,
    },
  });

  // The framework reads the policy from the request headers to put the nonce on its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // The seller layout cannot see the address it renders for; its sign-in guard reads this to keep path and query (W04 AS-84).
  requestHeaders.set('x-return-to', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  requestHeaders.set('Content-Security-Policy', policy);

  // A seller address with a broken percent sequence (`/%E0%A4%A`) is served as an unknown shop: the framework would answer
  // with a bare "400 Bad Request." page (B-084). The rewritten address is a malformed id, which shows the one not-found page.
  const response = hasBrokenPercent(request.nextUrl.pathname) && request.nextUrl.pathname.startsWith('/dashboard/seller/')
    ? NextResponse.rewrite(new URL('/dashboard/seller/not-a-shop', request.url), { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Reporting-Endpoints', `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
  return response;
}

export const config = {
  matcher: [
    {
      // Static assets, the liveness probe, the widget bundle and the API (rewritten to the backend) need no document policy.
      source: '/((?!api(?:/|$)|_next/static|_next/image|favicon\\.ico|health(?:/|$)|widget(?:/|$)).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
