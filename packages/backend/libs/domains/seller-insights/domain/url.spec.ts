import * as fc from 'fast-check';
import { normalizeUrl, UrlRefused } from './url';

describe('S41 AS-40: URL normalisation', () => {
  it.each([
    ['HTTPS://Shop.COM/p/1', 'https://shop.com/p/1'],
    ['https://BÜCHER.test/a', 'https://xn--bcher-kva.test/a'],
    ['https://shop.com:443/p', 'https://shop.com/p'],
    ['https://shop.com/p#reviews', 'https://shop.com/p'],
    ['https://shop.com/p/', 'https://shop.com/p'],
    ['https://shop.com/p//', 'https://shop.com/p'],
    ['https://shop.com/', 'https://shop.com/'],
    ['https://shop.com', 'https://shop.com/'],
    ['https://shop.com/p?', 'https://shop.com/p'],
    ['https://shop.com/p?utm_source=x', 'https://shop.com/p'],
    ['https://shop.com/p?b=2&a=1', 'https://shop.com/p?a=1&b=2'],
    ['https://shop.com/p?a=2&a=1&a=3', 'https://shop.com/p?a=1&a=2&a=3'],
    ['https://shop.com/p?a=1&b=2&a=0', 'https://shop.com/p?a=0&a=1&b=2'],
    ['https://shop.com/p?tag=x&utm_medium=m', 'https://shop.com/p?tag=x'],
    [
      'https://shop.com/p?color=red&variant=3&id=9',
      'https://shop.com/p?color=red&id=9&variant=3',
    ],
    ['https://shop.com/a%2fb', 'https://shop.com/a%2Fb'],
    ['https://shop.com/p?q=%e4%bd', 'https://shop.com/p?q=%E4%BD'],
    ['https://shop.com/a/./b/../c', 'https://shop.com/a/c'],
    ['https://shop.com/a/../../c', 'https://shop.com/c'],
    ['  https://shop.com/p  ', 'https://shop.com/p'],
  ])('S41 AS-40: %s -> %s', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it.each([
    'utm_source',
    'utm_campaign',
    'gclid',
    'gclsrc',
    'dclid',
    'fbclid',
    'msclkid',
    'yclid',
    'igshid',
    'mc_cid',
    'mc_eid',
    '_ga',
    '_gl',
    'ref',
    'ref_',
    'spm',
  ])('S41 AS-40: tracking parameter %s is removed', (name) => {
    expect(normalizeUrl(`https://shop.com/p?${name}=1&id=5`)).toBe(
      'https://shop.com/p?id=5',
    );
  });

  it.each([
    [`https://shop.com/${'a'.repeat(2040)}`, 'too_long'],
    ['https://user:pw@shop.com/p', 'credentials'],
    ['https://user@shop.com/p', 'credentials'],
    ['http://shop.com/p', 'scheme'],
    ['ftp://shop.com/p', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['https://shop.com:8443/p', 'port'],
    ['https://shop.com:80/p', 'port'],
    ['not a url', 'invalid'],
    ['', 'invalid'],
  ])('S41 AS-40: %s is refused (%s)', (input, reason) => {
    let error: unknown;
    try {
      normalizeUrl(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UrlRefused);
    expect((error as UrlRefused).reason).toBe(reason);
  });

  it('S41 AS-40: a URL of exactly 2048 characters is accepted', () => {
    const url = `https://shop.com/${'a'.repeat(2048 - 17)}`;
    expect(url).toHaveLength(2048);
    expect(() => normalizeUrl(url)).not.toThrow();
  });

  it('S41 AS-40: normalisation is idempotent (property)', () => {
    const seg = fc.stringMatching(/^[a-zA-Z0-9._~%-]{0,8}$/);
    const arb = fc
      .record({
        host: fc.constantFrom('Shop.com', 'BÜCHER.test', 'a.b.example'),
        path: fc.array(seg, { maxLength: 4 }),
        query: fc.array(
          fc.tuple(
            fc.constantFrom('a', 'B', 'utm_x', 'ref', 'tag', '_ga', 'q'),
            fc.stringMatching(/^[a-zA-Z0-9%]{0,5}$/),
          ),
          { maxLength: 5 },
        ),
        hash: fc.constantFrom('', '#x'),
        port: fc.constantFrom('', ':443'),
      })
      .map(
        ({ host, path, query, hash, port }) =>
          `https://${host}${port}/${path.join('/')}${
            query.length ? '?' : ''
          }${query.map(([k, v]) => `${k}=${v}`).join('&')}${hash}`,
      );
    fc.assert(
      fc.property(arb, (raw) => {
        let once: string;
        try {
          once = normalizeUrl(raw);
        } catch (e) {
          return e instanceof UrlRefused;
        }
        return normalizeUrl(once) === once;
      }),
      { numRuns: 500 },
    );
  });
});
