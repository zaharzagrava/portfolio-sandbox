import { describe, expect, it } from 'vitest';
import { productHref, searchHref, signInHref } from './routes';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

describe('routes', () => {
  it('W02 AS-02: productHref is /products/<id>', () => {
    expect(productHref(ID)).toBe(`/products/${ID}`);
  });

  it('W02 AS-02: productHref encodes anything that is not a path-safe id', () => {
    expect(productHref('a/b?c')).toBe('/products/a%2Fb%3Fc');
  });

  it('W02 AS-11: searchHref is the canonical address of the view', () => {
    expect(searchHref({})).toBe('/search');
    expect(searchHref({ q: 'iphone 17' })).toBe('/search?q=iphone+17');
    expect(searchHref({ sort: 'price-desc', category: 'phones', q: 'a' })).toBe('/search?q=a&category=phones&sort=price-desc');
  });

  it('W02 AS-18: searchHref keeps the cursor of the view it is given', () => {
    expect(searchHref({ q: 'a', category: 'x', cursor: 'tok' })).toBe('/search?q=a&category=x&cursor=tok');
  });

  it('W02 AS-12: searchHref cleans an invalid view the way the parser does', () => {
    expect(searchHref({ minPriceMinor: 500, maxPriceMinor: 100 })).toBe('/search');
    expect(searchHref({ semantic: true })).toBe('/search');
  });

  it('W02 AS-51: signInHref wraps W01 loginHref with a same-site returnTo', () => {
    expect(signInHref('/products/abc?tab=discussions')).toBe('/login?returnTo=%2Fproducts%2Fabc%3Ftab%3Ddiscussions');
    expect(signInHref('https://evil.example')).toBe('/login');
  });
});
