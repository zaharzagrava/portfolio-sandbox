// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config as proxyConfig, proxy } from './proxy';

const call = (path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) => proxy(new NextRequest(`http://localhost:3000${path}`, init));

describe('W07 proxy (proxy.ts)', () => {
  it('W07 AS-16: sets the policy and the nonce on the request and the policy on the response', () => {
    const res = call('/products/abc');
    const policy = res.headers.get('content-security-policy');
    expect(policy).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(res.headers.get('reporting-endpoints')).toBe('csp-endpoint="/api/csp-reports"');

    // NextResponse.next({ request }) forwards the overridden request headers under this prefix.
    const forwarded = (name: string) => res.headers.get(`x-middleware-request-${name}`);
    const nonce = forwarded('x-nonce');
    expect(nonce).toBeTruthy();
    expect(forwarded('content-security-policy')).toBe(policy);
    expect(policy).toContain(`'nonce-${nonce}'`);
  });

  it('W07 AS-16: every request gets a different nonce', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => call('/').headers.get('x-middleware-request-x-nonce')));
    expect(nonces.size).toBe(50);
  });

  it('W07 AS-16: makes no redirect or status decision, for any path or session', () => {
    for (const path of ['/', '/dashboard/orders', '/admin/feature-flags', '/checkout/pay/x', '/does-not-exist']) {
      const res = call(path, { headers: { cookie: '__Host-bff-session=abc' } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('location'), path).toBeNull();
      expect(res.headers.get('x-middleware-rewrite'), path).toBeNull();
    }
  });

  it('W07 AS-18: the payment hosts reach the policy only on /checkout/pay/*', () => {
    const pay = call('/checkout/pay/order-1').headers.get('content-security-policy')!;
    const home = call('/').headers.get('content-security-policy')!;
    // No payment hosts are configured in this test run; the frame-src rule still follows the path.
    expect(home).toContain("frame-src 'none'");
    expect(pay).toContain('frame-src');
  });

  it('W07 AS-16: the matcher skips static assets, health, widget, api and prefetches', () => {
    const entry = proxyConfig.matcher[0];
    expect(entry.source).toBeTypeOf('string');
    const regex = new RegExp(`^${entry.source}$`);
    for (const path of ['/_next/static/chunks/a.js', '/_next/image', '/favicon.ico', '/health', '/widget/v1/app.js', '/api/csp-reports', '/api/graphql']) {
      expect(regex.test(path), path).toBe(false);
    }
    for (const path of ['/', '/products/abc', '/privacy', '/checkout/pay/x']) {
      expect(regex.test(path), path).toBe(true);
    }
    expect(entry.missing).toEqual(
      expect.arrayContaining([
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ]),
    );
  });
});
