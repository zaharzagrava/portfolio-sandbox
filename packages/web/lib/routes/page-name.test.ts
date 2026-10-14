import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_TEMPLATES, pageNameFor } from './page-name';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const TOKEN = 'inv_SECRETtokenvalue1234567890';

describe('W07 page names (AS-35)', () => {
  it.each([
    ['/', '/'],
    ['/products/iphone-15-pro', '/products/:slug'],
    [`/products/${ID}`, '/products/:slug'],
    [`/invites/${TOKEN}`, '/invites/:token'],
    [`/checkout/pay/${ID}`, '/checkout/pay/:orderId'],
    ['/search', '/search'],
    ['/search?q=secret+words&page=2', '/search'],
    ['/search/', '/search'],
    ['/reset-password', '/reset-password'],
    ['/reset-password?token=abcdef', '/reset-password'],
    ['/reset-password#token=abcdef', '/reset-password'],
    [`/products/${ID}?ref=mail#reviews`, '/products/:slug'],
    ['/privacy/', '/privacy'],
    ['/dashboard/seller/9b2f/developers/api-keys', '/dashboard/seller/:shopId/developers/api-keys'],
  ])('W07 AS-35: %s is reported as %s', (path, expected) => {
    expect(pageNameFor(path)).toBe(expected);
  });

  it('W07 AS-35: an address that matches no page is reported as /not-found, whatever it contains', () => {
    for (const path of ['/nope', `/nope/${ID}`, '/products', '/products/a/b/c', '/<script>alert(1)</script>', `/${TOKEN}`]) {
      expect(pageNameFor(path), path).toBe('/not-found');
    }
  });

  it('W07 AS-35: a very long path is capped at 500 characters and never contains the address parts', () => {
    const long = `/products/${'x'.repeat(5000)}?token=${TOKEN}#frag`;
    const name = pageNameFor(long);
    expect(name.length).toBeLessThanOrEqual(500);
    expect(name).not.toContain('xxxx');
    expect(name).not.toContain(TOKEN);
    const unknown = pageNameFor(`/${'y'.repeat(5000)}`);
    expect(unknown).toBe('/not-found');
  });

  it('W07 AS-35: the root error is reported as /error; an unlisted template given by the caller is not trusted', () => {
    expect(pageNameFor('/anything', '/error')).toBe('/error');
    expect(pageNameFor(`/products/${ID}`, '/products/:slug')).toBe('/products/:slug');
    expect(pageNameFor(`/invites/${TOKEN}`, `/invites/${TOKEN}`)).toBe('/invites/:token');
  });

  it('W07 AS-35: no result ever contains an id, a token, a query or a fragment', () => {
    for (const path of [`/products/${ID}?a=b#c`, `/invites/${TOKEN}?x=1`, `/checkout/pay/${ID}#x`]) {
      const name = pageNameFor(path);
      expect(name).not.toMatch(/[?#]/);
      expect(name).not.toContain(ID);
      expect(name).not.toContain(TOKEN);
    }
  });

  it('W07 AS-35: every page under app/ has a template', () => {
    const appDir = join(__dirname, '..', '..', 'app');
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === 'page.tsx') pages.push(full);
      }
    };
    walk(appDir);
    expect(pages.length).toBeGreaterThan(10);
    const shape = (route: string) => route.replace(/:[A-Za-z]+/g, ':*');
    const known = new Set(PAGE_TEMPLATES.map(shape));
    const missing = pages
      .map((file) => {
        const segments = relative(appDir, file)
          .split(sep)
          .slice(0, -1)
          .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')))
          .map((segment) => (segment.startsWith('[') ? ':x' : segment));
        return `/${segments.join('/')}`;
      })
      .filter((route) => !known.has(shape(route)));
    expect(missing).toEqual([]);
  });
});
