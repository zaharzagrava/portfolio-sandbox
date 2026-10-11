import { describe, expect, it } from 'vitest';
import { buildCsp, generateNonce, type CspHosts } from './csp';

const NO_HOSTS: CspHosts = { mediaHosts: [], videoHosts: [], paymentProviderHosts: [] };
const HOSTS: CspHosts = {
  mediaHosts: ['https://media.example.com', 'https://media2.example.com:8443'],
  videoHosts: ['https://video.example.com'],
  mapTileHost: 'https://tiles.example.com',
  paymentProviderHosts: ['https://pay.example.com', 'https://3ds.example.com'],
};
const NONCE = 'bm9uY2U=';

/** `directive -> sources[]` of a policy string. */
function parse(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    out[name] = sources;
  }
  return out;
}

const csp = (over: Partial<Parameters<typeof buildCsp>[0]> = {}) =>
  parse(buildCsp({ nonce: NONCE, pathname: '/', isDev: false, hosts: NO_HOSTS, ...over }));

describe('W07 CSP builder (lib/security/csp.ts)', () => {
  it('W07 AS-16: production directives', () => {
    const policy = csp({ hosts: HOSTS });
    expect(policy).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"],
      'style-src': ["'self'", `'nonce-${NONCE}'`],
      'style-src-attr': ["'unsafe-inline'"],
      'font-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:', ...HOSTS.mediaHosts, 'https://tiles.example.com'],
      'media-src': ["'self'", 'blob:', 'https://video.example.com'],
      'connect-src': ["'self'"],
      'frame-src': ["'none'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': [],
      'report-uri': ['/api/csp-reports'],
      'report-to': ['csp-endpoint'],
    });
  });

  it('W07 AS-16: script-src never allows unsafe-inline (production and development)', () => {
    for (const isDev of [false, true]) {
      for (const pathname of ['/', '/checkout/pay/abc']) {
        expect(csp({ isDev, pathname, hosts: HOSTS })['script-src']).not.toContain("'unsafe-inline'");
      }
    }
  });

  it('W07 AS-16: development adds unsafe-eval and ws:/wss: only, and no upgrade-insecure-requests', () => {
    const prod = csp({ hosts: HOSTS });
    const dev = csp({ isDev: true, hosts: HOSTS });
    expect(dev['script-src']).toEqual([...prod['script-src'], "'unsafe-eval'"]);
    expect(dev['connect-src']).toEqual(["'self'", 'ws:', 'wss:']);
    expect(dev['upgrade-insecure-requests']).toBeUndefined();
    const { 'script-src': _a, 'connect-src': _b, 'upgrade-insecure-requests': _c, ...restDev } = dev;
    const { 'script-src': _d, 'connect-src': _e, 'upgrade-insecure-requests': _f, ...restProd } = prod;
    void [_a, _b, _c, _d, _e, _f];
    expect(restDev).toEqual(restProd);
  });

  it('W07 AS-16: the nonce is the one passed in; the policy is a single line without newlines', () => {
    const policy = buildCsp({ nonce: 'abc', pathname: '/', isDev: false, hosts: NO_HOSTS });
    expect(policy).toContain("'nonce-abc'");
    expect(policy).not.toMatch(/\n/);
  });

  it('W07 AS-18: map host is in img-src only when configured', () => {
    expect(csp({ hosts: HOSTS })['img-src']).toContain('https://tiles.example.com');
    expect(csp()['img-src']).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('W07 AS-18: payment hosts appear in script-src, connect-src and frame-src only for /checkout/pay/*', () => {
    for (const pathname of ['/checkout/pay/order-1', '/checkout/pay/order-1/step']) {
      const policy = csp({ pathname, hosts: HOSTS });
      for (const directive of ['script-src', 'connect-src', 'frame-src']) {
        expect(policy[directive], `${pathname} ${directive}`).toEqual(expect.arrayContaining(HOSTS.paymentProviderHosts));
      }
      expect(policy['frame-src']).not.toContain("'none'");
      expect(policy['img-src']).not.toContain('https://pay.example.com');
    }
    for (const pathname of ['/', '/checkout', '/checkout/payment', '/cart', '/products/x', '/checkout/pay']) {
      const policy = csp({ pathname, hosts: HOSTS });
      for (const directive of ['script-src', 'connect-src', 'frame-src', 'img-src']) {
        expect(policy[directive].join(' '), `${pathname} ${directive}`).not.toContain('pay.example.com');
        expect(policy[directive].join(' '), `${pathname} ${directive}`).not.toContain('3ds.example.com');
      }
      expect(policy['frame-src']).toEqual(["'none'"]);
    }
  });

  it('W07 AS-18: only exact hosts, never a wildcard or bare scheme', () => {
    const policy = buildCsp({ nonce: NONCE, pathname: '/checkout/pay/x', isDev: false, hosts: HOSTS });
    expect(policy).not.toContain('*');
    expect(policy).not.toMatch(/\shttps:(\s|;|$)/);
  });

  it('W07 AS-21: the policy names the same-origin report endpoint', () => {
    const policy = csp();
    expect(policy['report-uri']).toEqual(['/api/csp-reports']);
    expect(policy['report-to']).toEqual(['csp-endpoint']);
  });
});

describe('W07 nonce (generateNonce)', () => {
  it('W07 AS-16: at least 128 random bits, base64, new on every call', () => {
    const nonces = Array.from({ length: 100 }, () => generateNonce());
    expect(new Set(nonces).size).toBe(100);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(Buffer.from(nonce, 'base64').length).toBeGreaterThanOrEqual(16);
    }
  });
});
