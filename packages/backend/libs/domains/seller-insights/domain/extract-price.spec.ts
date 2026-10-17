import { extractPrice } from './extract-price';

const ld = (json: unknown, wrap: (s: string) => string = (s) => s): string =>
  `<html><head><script type="application/ld+json">${wrap(
    typeof json === 'string' ? json : JSON.stringify(json),
  )}</script></head><body>x</body></html>`;

const product = (offers: unknown, extra: object = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Kettle',
  offers,
  ...extra,
});

const offer = (price: unknown, priceCurrency: unknown, extra: object = {}) => ({
  '@type': 'Offer',
  price,
  priceCurrency,
  ...extra,
});

const price = (amountMinor: number, currency: string, source = 'json-ld') => ({
  kind: 'price',
  amountMinor,
  currency,
  source,
});

describe('S41 AS-33: JSON-LD prices and exact decimal conversion', () => {
  it.each([
    ['19.99', 'EUR', 1999],
    ['1.005', 'EUR', 101],
    ['1.004', 'EUR', 100],
    ['0.995', 'EUR', 100],
    ['0.01', 'EUR', 1],
    ['0.005', 'EUR', 1],
    ['0.004', 'EUR', null],
    ['1999', 'JPY', 1999],
    ['1999.5', 'JPY', 2000],
    ['1999.4', 'JPY', 1999],
    ['100000', 'KRW', 100000],
    ['1.234', 'KWD', 1234],
    ['1.2345', 'KWD', 1235],
    ['1.2344', 'KWD', 1234],
    ['5', 'BHD', 5000],
    ['5', 'USD', 500],
    ['5.', 'USD', null],
    ['.5', 'USD', null],
    ['10', 'EUR', 1000],
    ['0.1', 'EUR', 10],
    ['0.7', 'EUR', 70],
    ['1.15', 'EUR', 115],
    ['8.2', 'EUR', 820],
    ['4.35', 'EUR', 435],
    ['1.255', 'EUR', 126],
    ['00019.990', 'EUR', 1999],
    ['9999999999.99', 'EUR', 999999999999],
    ['10000000000.00', 'EUR', 1000000000000],
    ['10000000000.01', 'EUR', null],
    ['10000000000000', 'EUR', null],
    ['1000000000000', 'JPY', 1000000000000],
    ['1000000000001', 'JPY', null],
    ['1.299,00', 'EUR', null],
    ['1,299.00', 'EUR', null],
    ['19,99', 'EUR', null],
    ['1,299', 'EUR', null],
    ['0', 'EUR', null],
    ['0.00', 'EUR', null],
    ['-5', 'EUR', null],
    ['-0.01', 'EUR', null],
    ['+5', 'EUR', null],
    ['NaN', 'EUR', null],
    ['Infinity', 'EUR', null],
    ['1e3', 'EUR', null],
    ['', 'EUR', null],
    ['  ', 'EUR', null],
    ['abc', 'EUR', null],
    ['12 EUR', 'EUR', null],
    ['€12', 'EUR', null],
    ['1.2.3', 'EUR', null],
    ['0x10', 'EUR', null],
    [' 19.99 ', 'EUR', 1999],
  ])('S41 AS-33: string price %j %s -> %p', (amount, currency, expected) => {
    const result = extractPrice(ld(product(offer(amount, currency))));
    expect(result).toEqual(
      expected === null ? { kind: 'none' } : price(expected, currency),
    );
  });

  it.each([
    [19.99, 'EUR', 1999],
    [1999, 'JPY', 1999],
    [0.1, 'EUR', 10],
    [1.005, 'EUR', 101],
    [0, 'EUR', null],
    [-3, 'EUR', null],
    [1e21, 'EUR', null],
    [null, 'EUR', null],
    [true, 'EUR', null],
    [{ value: 3 }, 'EUR', null],
    [[3], 'EUR', null],
  ])('S41 AS-33: numeric price %p %s -> %p', (amount, currency, expected) => {
    const result = extractPrice(ld(product(offer(amount, currency))));
    expect(result).toEqual(
      expected === null ? { kind: 'none' } : price(expected, currency),
    );
  });

  it('S41 AS-33: NaN written in the JSON text yields no price', () => {
    expect(
      extractPrice(
        ld(
          '{"@type":"Product","offers":{"@type":"Offer","price":NaN,"priceCurrency":"EUR"}}',
        ),
      ),
    ).toEqual({ kind: 'none' });
  });

  it.each([
    ['eur', 'EUR'],
    ['Usd', 'USD'],
    [' gbp ', 'GBP'],
    ['EUR', 'EUR'],
    ['CHF', 'CHF'],
    ['PLN', 'PLN'],
  ])('S41 AS-33: currency %j is read as %s', (given, expected) => {
    expect(extractPrice(ld(product(offer('10', given))))).toEqual(
      price(1000, expected),
    );
  });

  it.each([
    [''],
    ['EURO'],
    ['XXX'],
    ['EU'],
    ['E1R'],
    ['ZZZ'],
    ['€'],
    [null],
    [undefined],
    [978],
    ['   '],
  ])('S41 AS-33: currency %p gives no price', (given) => {
    expect(extractPrice(ld(product(offer('10', given))))).toEqual({
      kind: 'none',
    });
  });

  it('S41 AS-33: a missing currency is never defaulted', () => {
    expect(
      extractPrice(ld(product({ '@type': 'Offer', price: '10' }))),
    ).toEqual({ kind: 'none' });
  });

  it.each([
    ['offers as an object', product(offer('10.00', 'EUR')), price(1000, 'EUR')],
    [
      'offers as an array',
      product([offer('10.00', 'EUR'), offer('12.00', 'EUR')]),
      price(1000, 'EUR'),
    ],
    [
      'offers as an array, lowest wins regardless of order',
      product([offer('12.00', 'EUR'), offer('10.00', 'EUR')]),
      price(1000, 'EUR'),
    ],
    [
      'AggregateOffer.lowPrice',
      product({
        '@type': 'AggregateOffer',
        lowPrice: '8.50',
        highPrice: '20',
        priceCurrency: 'EUR',
      }),
      price(850, 'EUR'),
    ],
    [
      'AggregateOffer.lowPrice as number',
      product({
        '@type': 'AggregateOffer',
        lowPrice: 8.5,
        priceCurrency: 'EUR',
      }),
      price(850, 'EUR'),
    ],
    [
      '@type as an array on the product',
      product(offer('10', 'EUR'), { '@type': ['Product', 'Thing'] }),
      price(1000, 'EUR'),
    ],
    [
      '@type as an array on the offer',
      product(offer('10', 'EUR', { '@type': ['Offer', 'Thing'] })),
      price(1000, 'EUR'),
    ],
    [
      '@graph',
      {
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebSite', name: 'Shop' },
          product(offer('10', 'EUR')),
        ],
      },
      price(1000, 'EUR'),
    ],
    [
      'top-level array of nodes',
      [{ '@type': 'Organization' }, product(offer('10', 'EUR'))],
      price(1000, 'EUR'),
    ],
    [
      'a non-product node is ignored',
      { '@type': 'Organization', offers: offer('10', 'EUR') },
      { kind: 'none' },
    ],
    [
      'availability as schema.org URL in stock',
      product(
        offer('10', 'EUR', { availability: 'https://schema.org/InStock' }),
      ),
      price(1000, 'EUR'),
    ],
  ])('S41 AS-33: %s', (_name, json, expected) => {
    expect(extractPrice(ld(json))).toEqual(expected);
  });

  it.each([
    ['https://schema.org/OutOfStock'],
    ['http://schema.org/OutOfStock'],
    ['OutOfStock'],
    ['schema:OutOfStock'],
    ['https://schema.org/Discontinued'],
    ['Discontinued'],
    ['https://schema.org/SoldOut'],
    ['SoldOut'],
  ])('S41 AS-33: availability %s is out of stock', (availability) => {
    expect(
      extractPrice(ld(product(offer('10', 'EUR', { availability })))),
    ).toEqual({ kind: 'out_of_stock' });
  });

  it('S41 AS-33: out of stock offers are skipped when others are in stock', () => {
    const json = product([
      offer('5', 'EUR', { availability: 'https://schema.org/OutOfStock' }),
      offer('10', 'EUR', { availability: 'https://schema.org/InStock' }),
    ]);
    expect(extractPrice(ld(json))).toEqual(price(1000, 'EUR'));
  });

  it('S41 AS-33: all offers out of stock gives out_of_stock', () => {
    const json = product([
      offer('5', 'EUR', { availability: 'OutOfStock' }),
      offer('6', 'EUR', { availability: 'Discontinued' }),
    ]);
    expect(extractPrice(ld(json))).toEqual({ kind: 'out_of_stock' });
  });

  it('S41 AS-33: out of stock product followed by in-stock product yields the price', () => {
    const json = [
      product(offer('5', 'EUR', { availability: 'OutOfStock' })),
      product(offer('7', 'EUR')),
    ];
    expect(extractPrice(ld(json))).toEqual(price(700, 'EUR'));
  });

  it('S41 AS-33: out of stock wins over a meta fallback', () => {
    const html =
      ld(product(offer('5', 'EUR', { availability: 'OutOfStock' }))) +
      '<meta property="og:price:amount" content="5"><meta property="og:price:currency" content="EUR">';
    expect(extractPrice(html)).toEqual({ kind: 'out_of_stock' });
  });

  it('S41 AS-33: offers in two currencies on one product are ambiguous', () => {
    const json = product([offer('10', 'EUR'), offer('11', 'USD')]);
    expect(extractPrice(ld(json))).toEqual({ kind: 'none' });
  });

  it('S41 AS-33: an ambiguous product does not block the next product', () => {
    const json = [
      product([offer('10', 'EUR'), offer('11', 'USD')]),
      product(offer('9', 'GBP')),
    ];
    expect(extractPrice(ld(json))).toEqual(price(900, 'GBP'));
  });

  it('S41 AS-33: out of stock offer in another currency does not make a product ambiguous', () => {
    const json = product([
      offer('10', 'EUR'),
      offer('11', 'USD', { availability: 'OutOfStock' }),
    ]);
    expect(extractPrice(ld(json))).toEqual(price(1000, 'EUR'));
  });

  it('S41 AS-33: several products, first in document order that yields a price', () => {
    const json = [
      product(offer('abc', 'EUR')),
      product(offer('30', 'EUR')),
      product(offer('20', 'EUR')),
    ];
    expect(extractPrice(ld(json))).toEqual(price(3000, 'EUR'));
  });

  it('S41 AS-33: first script wins over the second', () => {
    const html =
      ld(product(offer('30', 'EUR'))) + ld(product(offer('20', 'EUR')));
    expect(extractPrice(html)).toEqual(price(3000, 'EUR'));
  });

  it('S41 AS-33: malformed JSON-LD is skipped and the next script is read', () => {
    const html = ld('{ "@type": "Product", ') + ld(product(offer('20', 'EUR')));
    expect(extractPrice(html)).toEqual(price(2000, 'EUR'));
  });

  it.each([
    ['CDATA', (s: string) => `//<![CDATA[\n${s}\n//]]>`],
    ['CDATA plain', (s: string) => `<![CDATA[${s}]]>`],
    ['HTML comment', (s: string) => `<!--\n${s}\n-->`],
  ])('S41 AS-33: JSON-LD wrapped in %s is read', (_name, wrap) => {
    expect(extractPrice(ld(product(offer('20', 'EUR')), wrap))).toEqual(
      price(2000, 'EUR'),
    );
  });

  it.each([
    [
      'single quoted type',
      `<script type='application/ld+json'>${JSON.stringify(product(offer('1', 'EUR')))}</script>`,
    ],
    [
      'extra attributes and case',
      `<SCRIPT id="x" type="Application/LD+JSON" data-n="1">${JSON.stringify(product(offer('1', 'EUR')))}</SCRIPT>`,
    ],
  ])('S41 AS-33: script tag variant %s', (_name, html) => {
    expect(extractPrice(html)).toEqual(price(100, 'EUR'));
  });

  it('S41 AS-33: non JSON-LD scripts are ignored', () => {
    const html = `<script>var p = {"@type":"Product","offers":{"price":"5","priceCurrency":"EUR"}}</script>`;
    expect(extractPrice(html)).toEqual({ kind: 'none' });
  });
});

describe('S41 AS-33: meta fallback', () => {
  const meta = (attrs: string) => `<meta ${attrs}>`;

  it.each([
    [
      'product:price',
      meta('property="product:price:amount" content="19.99"') +
        meta('property="product:price:currency" content="EUR"'),
      1999,
      'EUR',
    ],
    [
      'og:price',
      meta('property="og:price:amount" content="19.99"') +
        meta('property="og:price:currency" content="usd"'),
      1999,
      'USD',
    ],
    [
      'itemprop',
      meta('itemprop="price" content="1999"') +
        meta('itemprop="priceCurrency" content="JPY"'),
      1999,
      'JPY',
    ],
    [
      'attributes in reverse order',
      meta('content="19.99" property="product:price:amount"') +
        meta('content="EUR" property="product:price:currency"'),
      1999,
      'EUR',
    ],
    [
      'single quotes',
      meta(`property='product:price:amount' content='19.99'`) +
        meta(`property='product:price:currency' content='EUR'`),
      1999,
      'EUR',
    ],
    [
      'self closing and extra attributes',
      `<meta data-x="1" property="og:price:amount" content="19.99" />` +
        `<meta data-x="2" property="og:price:currency" content="EUR" />`,
      1999,
      'EUR',
    ],
    [
      'name attribute',
      meta('name="product:price:amount" content="19.99"') +
        meta('name="product:price:currency" content="EUR"'),
      1999,
      'EUR',
    ],
    [
      'itemprop on non-meta elements',
      `<span itemprop="price" content="19.99">19,99</span><meta itemprop="priceCurrency" content="EUR">`,
      1999,
      'EUR',
    ],
    [
      'uppercase tag and attribute names',
      `<META PROPERTY="og:price:amount" CONTENT="19.99"><META PROPERTY="og:price:currency" CONTENT="EUR">`,
      1999,
      'EUR',
    ],
    [
      'half-up rounding',
      meta('property="og:price:amount" content="1.005"') +
        meta('property="og:price:currency" content="EUR"'),
      101,
      'EUR',
    ],
  ])('S41 AS-33: meta %s', (_name, html, amountMinor, currency) => {
    expect(extractPrice(html)).toEqual(price(amountMinor, currency, 'meta'));
  });

  it.each([
    [
      'amount without currency',
      meta('property="product:price:amount" content="19.99"'),
    ],
    [
      'currency without amount',
      meta('property="product:price:currency" content="EUR"'),
    ],
    [
      'ambiguous amount',
      meta('property="product:price:amount" content="1.299,00"') +
        meta('property="product:price:currency" content="EUR"'),
    ],
    [
      'zero amount',
      meta('property="product:price:amount" content="0"') +
        meta('property="product:price:currency" content="EUR"'),
    ],
    [
      'unknown currency',
      meta('property="product:price:amount" content="5"') +
        meta('property="product:price:currency" content="EURO"'),
    ],
    [
      'amount in og without currency in og',
      meta('property="og:price:amount" content="5"') +
        meta('property="product:price:currency" content="EUR"'),
    ],
  ])('S41 AS-33: meta %s gives no price', (_name, html) => {
    expect(extractPrice(html)).toEqual({ kind: 'none' });
  });

  it('S41 AS-33: JSON-LD price wins over meta', () => {
    const html =
      ld(product(offer('20', 'EUR'))) +
      meta('property="og:price:amount" content="5"') +
      meta('property="og:price:currency" content="EUR"');
    expect(extractPrice(html)).toEqual(price(2000, 'EUR'));
  });

  it('S41 AS-33: meta is used when JSON-LD gives no price', () => {
    const html =
      ld(product(offer('abc', 'EUR'))) +
      meta('property="og:price:amount" content="5"') +
      meta('property="og:price:currency" content="EUR"');
    expect(extractPrice(html)).toEqual(price(500, 'EUR', 'meta'));
  });

  it('S41 AS-33: product:price wins over og:price', () => {
    const html =
      meta('property="og:price:amount" content="5"') +
      meta('property="og:price:currency" content="EUR"') +
      meta('property="product:price:amount" content="6"') +
      meta('property="product:price:currency" content="EUR"');
    expect(extractPrice(html)).toEqual(price(600, 'EUR', 'meta'));
  });
});

describe('S41 AS-33: never free text', () => {
  it.each([
    ['was and now', '<p>was €199, now only €149!</p>'],
    ['dollar', '<span class="price">$19.99</span>'],
    ['empty document', ''],
    ['no markup', 'Price: 19.99 EUR'],
    ['title with price', '<title>Kettle 19.99 EUR</title>'],
    ['price class', '<div class="price" data-price="19.99">19.99 EUR</div>'],
  ])('S41 AS-33: %s yields no price', (_name, html) => {
    expect(extractPrice(html)).toEqual({ kind: 'none' });
  });
});
