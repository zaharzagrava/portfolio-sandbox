import { normalizeUrl } from './url';
import { isAllowed, parseRobots } from './robots';
import { simhash, simhashDistance, visibleText } from './simhash';
import { extractPrice } from './extract-price';

/** Crawler building blocks - pure, unit-tested. */
describe('crawler primitives', () => {
  it('normalizes URLs into one crawl target', () => {
    expect(
      normalizeUrl(
        'HTTPS://Shop.COM:443/p/1/?utm_source=x&b=2&a=1&gclid=z#reviews',
      ),
    ).toBe('https://shop.com/p/1?a=1&b=2');
  });

  it('robots.txt: our group beats *, longest rule wins, wildcards and $ work', () => {
    const rules = parseRobots(
      [
        'User-agent: *',
        'Disallow: /',
        '',
        'User-agent: MarketplacePriceBot',
        'Disallow: /private',
        'Allow: /private/public-*',
        'Disallow: /*.pdf$',
        'Crawl-delay: 5',
      ].join('\n'),
      'MarketplacePriceBot/1.0',
    );
    expect(rules.crawlDelaySec).toBe(5);
    expect(isAllowed(rules, '/p/1')).toBe(true);
    expect(isAllowed(rules, '/private/x')).toBe(false);
    expect(isAllowed(rules, '/private/public-offers')).toBe(true);
    expect(isAllowed(rules, '/docs/manual.pdf')).toBe(false);
    expect(
      isAllowed(
        parseRobots('User-agent: *\nDisallow: /', 'OtherBot'),
        '/anything',
      ),
    ).toBe(false);
  });

  it('SimHash: a rotated widget is near, a different page is far', () => {
    const page = (widget: string) =>
      `iPhone 17 Pro 256GB Natural Titanium. Price 1199. Free delivery tomorrow. ${'Specs and details. '.repeat(30)} People also bought ${widget}`;
    expect(
      simhashDistance(simhash(page('a case')), simhash(page('a charger'))),
    ).toBeLessThanOrEqual(6);
    expect(
      simhashDistance(
        simhash(page('a case')),
        simhash(
          'Completely unrelated gardening article about tomatoes and soil acidity levels in spring',
        ),
      ),
    ).toBeGreaterThan(15);
    expect(
      visibleText('<p>Hi</p><script>var x=1</script><style>p{}</style>'),
    ).toBe('Hi');
  });

  it('extracts prices from JSON-LD (incl. @graph / AggregateOffer) before meta tags', () => {
    expect(
      extractPrice(
        '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","offers":{"@type":"Offer","price":"1099.00","priceCurrency":"eur"}}</script>',
      ),
    ).toEqual({ amountMinor: 109_900, currency: 'EUR', source: 'json-ld' });
    expect(
      extractPrice(
        '<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Product","offers":{"@type":"AggregateOffer","lowPrice":49.5,"priceCurrency":"USD"}}]}</script>',
      )?.amountMinor,
    ).toBe(4_950);
    expect(
      extractPrice(
        '<meta property="product:price:amount" content="19.99"><meta property="product:price:currency" content="GBP">',
      ),
    ).toEqual({ amountMinor: 1_999, currency: 'GBP', source: 'meta' });
    expect(extractPrice('<p>was €199, now only €149!</p>')).toBeNull();
  });
});
