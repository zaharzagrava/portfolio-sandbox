import { matchOrigin, normalizeOrigin, normalizeOrigins } from './origin';

const ACCEPTED: [string, string][] = [
  ['https://www.my-shop.com', 'https://www.my-shop.com'],
  ['HTTPS://WWW.My-Shop.COM', 'https://www.my-shop.com'],
  ['https://shop.example:8443', 'https://shop.example:8443'],
  ['https://shop.com:443', 'https://shop.com'],
  ['https://bücher.example', 'https://xn--bcher-kva.example'],
];

const REJECTED: [unknown, string][] = [
  ['http://shop.com', 'not_https'],
  ['https://shop.com/path', 'not_an_origin'],
  ['https://shop.com/', 'not_an_origin'],
  ['https://shop.com/?q=1', 'not_an_origin'],
  ['https://shop.com?q=1', 'not_an_origin'],
  ['https://shop.com/#x', 'not_an_origin'],
  ['https://shop.com#x', 'not_an_origin'],
  ['https://user:pw@shop.com', 'userinfo'],
  ['https://*.shop.com', 'wildcard'],
  ['https://192.168.1.1', 'ip_literal'],
  ['https://[::1]', 'ip_literal'],
  ['https://8.8.8.8', 'ip_literal'],
  ['https://localhost', 'localhost'],
  ['https://app.localhost', 'localhost'],
  ['https://intranet', 'single_label_host'],
  ['https://shop.com.', 'trailing_dot'],
  ['shop.com', 'malformed'],
  ['', 'malformed'],
  ['null', 'malformed'],
  ['ftp://shop.com', 'malformed'],
  [`https://${'a'.repeat(250)}.com`, 'malformed'],
  [42, 'malformed'],
  [null, 'malformed'],
  [' https://shop.com', 'malformed'],
  ['https://shop.com:0', 'bad_port'],
  ['https://shop.com:65536', 'bad_port'],
  ['https://shop.com:abc', 'malformed'],
  ['https://shop.com:', 'malformed'],
  ['https://-bad-.shop.com', 'malformed'],
  ['https://sho p.com', 'malformed'],
];

describe('S44 AS-02 origin rule', () => {
  it.each(ACCEPTED)('S44 AS-02: accepts %s as %s', (input, expected) => {
    expect(normalizeOrigin(input)).toEqual({ ok: true, origin: expected });
  });

  it.each(REJECTED)('S44 AS-02: rejects %j with %s', (input, reason) => {
    expect(normalizeOrigin(input)).toEqual({ ok: false, reason });
  });

  it('S44 AS-03: duplicates collapse after normalisation, first position kept', () => {
    expect(
      normalizeOrigins([
        'https://Shop.com',
        'https://other.example',
        'https://shop.com:443',
      ]),
    ).toEqual({
      ok: true,
      origins: ['https://shop.com', 'https://other.example'],
    });
  });

  it('S44 AS-02: the first rejected origin is reported with its input', () => {
    expect(
      normalizeOrigins(['https://ok.example', 'http://bad.example']),
    ).toEqual({ ok: false, origin: 'http://bad.example', reason: 'not_https' });
  });
});

const REGISTERED = ['https://www.my-shop.com', 'https://shop.example:8443'];

const MATCH: [unknown, boolean][] = [
  ['https://www.my-shop.com', true],
  ['https://WWW.MY-SHOP.COM', true],
  ['https://www.my-shop.com:443', true],
  ['https://shop.example:8443', true],
  ['http://www.my-shop.com', false],
  ['https://my-shop.com', false],
  ['https://evil-www.my-shop.com', false],
  ['https://www.my-shop.com.evil.com', false],
  ['https://www.my-shop.com@evil.com', false],
  ['https://evilwww.my-shop.com', false],
  ['https://shop.example', false],
  ['https://shop.example:8444', false],
  ['https://sub.www.my-shop.com', false],
  ['null', false],
  ['', false],
  [undefined, false],
  [['https://www.my-shop.com'], false],
  ['https://www.my-shop.com/', false],
  ['https://www.my-shop.com/path', false],
  ['https://www.my-shop.com, https://shop.example:8443', false],
  ['https://wwш.my-shop.com', false],
];

describe('S44 AS-15 origin matching', () => {
  it.each(MATCH)('S44 AS-15: %j -> %s', (candidate, expected) => {
    expect(matchOrigin(REGISTERED, candidate)).toBe(expected);
  });
});
