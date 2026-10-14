/** Content Security Policy for one response (contracts/security-headers.md). Pure: `proxy.ts` supplies nonce, path and hosts. */

export type CspHosts = {
  mediaHosts: string[];
  videoHosts: string[];
  mapTileHost?: string;
  paymentProviderHosts: string[];
};

export type CspInput = { nonce: string; pathname: string; isDev: boolean; hosts: CspHosts };

export const CSP_REPORT_PATH = '/api/csp-reports';
export const CSP_REPORT_GROUP = 'csp-endpoint';

/** 128 random bits, base64; a fresh value for every response. Works in the Edge-like proxy runtime and in Node. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const PAYMENT_PATH = /^\/checkout\/pay\/[^/]+/;

export function buildCsp({ nonce, pathname, isDev, hosts }: CspInput): string {
  const payment = PAYMENT_PATH.test(pathname) ? hosts.paymentProviderHosts : [];
  const self = "'self'";
  // MapLibre loads raster tiles with `fetch` and runs a worker from a `blob:` URL; hls.js loads playlists and segments with `fetch`.
  const fetched = [...(hosts.mapTileHost ? [hosts.mapTileHost] : []), ...hosts.videoHosts];

  const directives: Record<string, string[]> = {
    'default-src': [self],
    'script-src': [self, `'nonce-${nonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : []), ...payment],
    'style-src': [self, `'nonce-${nonce}'`],
    // UI libraries set inline style attributes; styles cannot run code.
    'style-src-attr': ["'unsafe-inline'"],
    'font-src': [self],
    'img-src': [self, 'data:', 'blob:', ...hosts.mediaHosts, ...(hosts.mapTileHost ? [hosts.mapTileHost] : [])],
    'media-src': [self, 'blob:', ...hosts.videoHosts],
    'connect-src': [self, ...(isDev ? ['ws:', 'wss:'] : []), ...fetched, ...payment],
    ...(fetched.length > 0 ? { 'worker-src': [self, 'blob:'] } : {}),
    'frame-src': payment.length > 0 ? payment : ["'none'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': [self],
    'form-action': [self],
    ...(isDev ? {} : { 'upgrade-insecure-requests': [] }),
    'report-uri': [CSP_REPORT_PATH],
    'report-to': [CSP_REPORT_GROUP],
  };

  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ');
}
