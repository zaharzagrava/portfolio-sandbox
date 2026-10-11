import { NextResponse, type NextRequest } from 'next/server';
import { parseConfig } from '@/lib/config-parse';
import { buildCsp, CSP_REPORT_GROUP, CSP_REPORT_PATH, generateNonce } from '@/lib/security/csp';

// Parsed once per process. `lib/config.ts` is `server-only` and cannot be imported here.
const appConfig = parseConfig(process.env);

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
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
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
