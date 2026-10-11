import { describe, expect, it } from 'vitest';
import {
  canonicalKeyPart,
  clearFilters,
  firstPage,
  parseSearchView,
  searchRequestParams,
  toSearchParams,
  withChange,
} from './search-view';

const canonical = (query: string) => toSearchParams(parseSearchView(new URLSearchParams(query)).view).toString();

describe('SearchView', () => {
  it.each([
    ['empty address is the empty view', '', ''],
    ['q is trimmed', 'q=%20%20iphone%20%20', 'q=iphone'],
    ['blank q is dropped', 'q=%20%20', ''],
    ['unknown parameters are dropped', 'q=a&utm_source=x&foo=1', 'q=a'],
    ['legacy priceMin, priceMax, rating, nearMe, size, from are dropped', 'priceMin=1&priceMax=9&rating=4&nearMe=1&size=20&from=10', ''],
    ['repeated parameter: the first value wins', 'q=a&q=b&category=x&category=y', 'q=a&category=x'],
    ['negative or non-numeric prices are dropped', 'minPriceMinor=-1&maxPriceMinor=abc', ''],
    ['min above max drops both', 'minPriceMinor=500&maxPriceMinor=100', ''],
    ['min equal to max is kept', 'minPriceMinor=100&maxPriceMinor=100', 'minPriceMinor=100&maxPriceMinor=100'],
    ['only one bound is kept', 'maxPriceMinor=100', 'maxPriceMinor=100'],
    ['minRating outside 1..5 is dropped', 'minRating=0', ''],
    ['minRating 6 is dropped', 'minRating=6', ''],
    ['minRating 4 is kept', 'minRating=4', 'minRating=4'],
    ['minRating with a fraction is dropped', 'minRating=4.5', ''],
    ['inStock only accepts true', 'inStock=1', ''],
    ['inStock=true is kept', 'inStock=true', 'inStock=true'],
    ['unknown sort is dropped', 'q=a&sort=cheapest', 'q=a'],
    ['sort=relevance with q is the default and is omitted', 'q=a&sort=relevance', 'q=a'],
    ['sort=relevance without q is dropped', 'sort=relevance', ''],
    ['sort=price-desc is kept with or without q', 'sort=price-desc', 'sort=price-desc'],
    ['semantic without q is dropped', 'semantic=true', ''],
    ['semantic with q is kept', 'q=a&semantic=true', 'q=a&semantic=true'],
    ['semantic only accepts true', 'q=a&semantic=1', 'q=a'],
    ['near accepts 1 only', 'near=true', ''],
    ['near=1 is kept', 'near=1', 'near=1'],
    ['radiusKm 5 is the default and is omitted', 'near=1&radiusKm=5', 'near=1'],
    ['radiusKm 20 is kept', 'near=1&radiusKm=20', 'near=1&radiusKm=20'],
    ['radiusKm outside the choices is dropped', 'near=1&radiusKm=7', 'near=1'],
    ['cursor over 2048 characters is dropped', `cursor=${'a'.repeat(2049)}`, ''],
    ['cursor of 2048 characters is kept', `cursor=${'a'.repeat(2048)}`, `cursor=${'a'.repeat(2048)}`],
    ['parameters come out in the fixed order', 'cursor=c&near=1&sort=newest&inStock=true&minRating=3&brand=b&category=c&q=a', 'q=a&category=c&brand=b&minRating=3&inStock=true&sort=newest&near=1&cursor=c'],
  ])('W02 AS-12: %s', (_name, input, expected) => {
    expect(canonical(input)).toBe(expected);
  });

  it('W02 AS-12: a q longer than 100 characters is cut to 100', () => {
    const { view } = parseSearchView(new URLSearchParams({ q: 'x'.repeat(150) }));
    expect(view.q).toBe('x'.repeat(100));
  });

  it('W02 AS-12: category and brand over 100 characters are dropped', () => {
    const { view } = parseSearchView(new URLSearchParams({ category: 'c'.repeat(101), brand: 'b'.repeat(100) }));
    expect(view.category).toBeUndefined();
    expect(view.brand).toBe('b'.repeat(100));
  });

  it('W02 AS-12: parsing is total: no input throws', () => {
    const hostile = ['%', '%E0%A4%A', 'q[]=a', 'q=%00', '=&=&=', 'minPriceMinor=1e3', `q=${'😀'.repeat(300)}`, 'minPriceMinor=99999999999999999999'];
    for (const query of hostile) expect(() => parseSearchView(new URLSearchParams(query))).not.toThrow();
    expect(() => parseSearchView({ q: ['a', 'b'], sort: undefined })).not.toThrow();
    expect(() => parseSearchView(undefined as never)).not.toThrow();
  });

  it('W02 AS-11: changed reports whether the address differs from its canonical form', () => {
    expect(parseSearchView(new URLSearchParams('q=a&category=c')).changed).toBe(false);
    expect(parseSearchView(new URLSearchParams('category=c&q=a')).changed).toBe(true);
    expect(parseSearchView(new URLSearchParams('q=a&priceMin=3')).changed).toBe(true);
    expect(parseSearchView(new URLSearchParams('')).changed).toBe(false);
  });

  it('W02 AS-11: accepts the searchParams record of a page (strings, arrays, undefined)', () => {
    const { view, changed } = parseSearchView({ q: ['first', 'second'], category: 'audio', brand: undefined });
    expect(view).toEqual({ q: 'first', category: 'audio' });
    expect(changed).toBe(true);
  });

  it('W02 AS-11: toSearchParams of the parsed view is stable (parse of the canonical form is unchanged)', () => {
    const first = parseSearchView(new URLSearchParams('near=1&q=a%20b&sort=price-asc&minPriceMinor=1000&maxPriceMinor=50000'));
    const second = parseSearchView(toSearchParams(first.view));
    expect(second.view).toEqual(first.view);
    expect(second.changed).toBe(false);
  });

  it('W02 AS-14: any change except the cursor removes the cursor; a cursor-only change keeps the rest', () => {
    const view = { q: 'a', cursor: 'c1' };
    expect(withChange(view, { category: 'x' })).toEqual({ q: 'a', category: 'x' });
    expect(withChange(view, { semantic: true })).toEqual({ q: 'a', semantic: true });
    expect(withChange(view, { near: 1 })).toEqual({ q: 'a', near: 1 });
    expect(withChange(view, { cursor: 'c2' })).toEqual({ q: 'a', cursor: 'c2' });
  });

  it('W02 AS-14: undefined in a change clears the field; the result is a canonical view', () => {
    expect(withChange({ q: 'a', category: 'x' }, { category: undefined })).toEqual({ q: 'a' });
    expect(withChange({ q: 'a', sort: 'newest' }, { q: undefined })).toEqual({ sort: 'newest' });
    expect(withChange({ q: 'a', semantic: true }, { q: undefined })).toEqual({});
    expect(withChange({ q: 'a' }, { minPriceMinor: 500, maxPriceMinor: 100 })).toEqual({ q: 'a' });
  });

  it('W02 AS-17: clear all filters keeps q and sort only', () => {
    const view = { q: 'a', sort: 'price-asc' as const, category: 'c', brand: 'b', minPriceMinor: 1, maxPriceMinor: 2, minRating: 3, inStock: true as const, semantic: true as const, cursor: 'c' };
    expect(clearFilters(view)).toEqual({ q: 'a', sort: 'price-asc' });
  });

  it('W02 AS-18: back to first page removes the cursor', () => {
    expect(firstPage({ q: 'a', cursor: 'c' })).toEqual({ q: 'a' });
  });

  it('W02 AS-10: the request carries the canonical parameters, limit 24 and facets=true', () => {
    const params = searchRequestParams({ q: 'phone', category: 'phones', brand: 'apple', minPriceMinor: 1000, maxPriceMinor: 50000, minRating: 4, inStock: true, sort: 'price-desc', cursor: 'abc' });
    expect(Object.fromEntries(params)).toEqual({
      q: 'phone',
      category: 'phones',
      brand: 'apple',
      minPriceMinor: '1000',
      maxPriceMinor: '50000',
      minRating: '4',
      inStock: 'true',
      sort: 'price-desc',
      facets: 'true',
      limit: '24',
      cursor: 'abc',
    });
  });

  it('W02 AS-21: semantic requests omit facets and send semantic=true', () => {
    const params = searchRequestParams({ q: 'phone', semantic: true });
    expect(params.get('semantic')).toBe('true');
    expect(params.has('facets')).toBe(false);
    expect(params.get('limit')).toBe('24');
  });

  it('W02 AS-10: browse mode (no q) sends no q', () => {
    expect(searchRequestParams({}).has('q')).toBe(false);
    expect(searchRequestParams({}).get('facets')).toBe('true');
  });

  it('W02 AS-30: with near=1 the request carries only q, radiusKm, cursor and the coordinates', () => {
    const view = { q: 'cable', category: 'x', minPriceMinor: 1, sort: 'newest' as const, near: 1 as const, cursor: 'c' };
    const params = searchRequestParams(view, { lat: 52.52, lng: 13.405 });
    expect(Object.fromEntries(params)).toEqual({ q: 'cable', radiusKm: '5', cursor: 'c', lat: '52.52', lng: '13.405' });
    expect(Object.fromEntries(searchRequestParams({ near: 1, radiusKm: 20 }))).toEqual({ radiusKm: '20' });
  });

  it('W02 AS-71: equal views share a key part; different views do not', () => {
    const a = parseSearchView(new URLSearchParams('q=a&category=c')).view;
    const b = parseSearchView(new URLSearchParams('category=c&q=a&utm=1&priceMin=3')).view;
    expect(canonicalKeyPart(a)).toBe(canonicalKeyPart(b));
    expect(canonicalKeyPart(a)).not.toBe(canonicalKeyPart({ q: 'a' }));
  });
});
