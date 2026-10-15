import {
  isBlockedAddress,
  validateShopifyDomain,
  validateStoreUrl,
} from './store-address';

describe('S08 store address guard', () => {
  it.each([
    ['https://shop.example.com', 'https://shop.example.com'],
    ['https://Shop.Example.com/', 'https://shop.example.com'],
    ['https://shop.example.com:443', 'https://shop.example.com'],
    ['https://shop.example.com/store/', 'https://shop.example.com/store'],
    ['  https://shop.example.com  ', 'https://shop.example.com'],
    ['https://shop.example.com./', 'https://shop.example.com'],
    ['https://shop.example.com/?x=1#frag', 'https://shop.example.com'],
    ['https://bücher.example/', 'https://xn--bcher-kva.example'],
  ])('S08 AS-07: accepts %s as %s', (input, baseUrl) => {
    expect(validateStoreUrl(input)).toEqual({ ok: true, baseUrl });
  });

  it.each([
    'http://shop.example.com',
    'ftp://shop.example.com',
    'javascript:alert(1)',
    '//shop.example.com',
    'shop.example.com',
    '',
    'https://user@shop.example.com',
    'https://user:pw@shop.example.com',
    'https://:pw@shop.example.com',
    'https://shop.example.com:8443',
    'https://shop.example.com:80',
    'https://shop.example.com:444',
    'https://localhost',
    'https://LOCALHOST/',
    'https://foo.localhost',
    'https://intranet',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://172.16.0.1',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://8.8.8.8',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[2001:db8::1]',
    'https://[fe80::1]',
    'https://2130706433',
    'https://0x7f000001',
    'https://0177.0.0.1',
    'https://127.1',
    `https://${'a'.repeat(250)}.example.com`,
    'https://exa mple.com',
  ])('S08 AS-07: rejects %j with invalid_store_url', (input) => {
    expect(validateStoreUrl(input)).toMatchObject({
      ok: false,
      code: 'invalid_store_url',
    });
  });

  it('S08 AS-07: non-strings are rejected', () => {
    expect(validateStoreUrl(undefined as never)).toMatchObject({ ok: false });
    expect(validateStoreUrl(5 as never)).toMatchObject({ ok: false });
  });

  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.255.255.255',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.0.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'febf::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::7f00:1',
    'not-an-ip',
    '',
  ])('S08 AS-07: resolved address %j is blocked', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '11.0.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
  ])('S08 AS-07: resolved address %j is allowed', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('S08 Shopify shop domain', () => {
  it.each([
    ['fake-store.myshopify.com', 'fake-store.myshopify.com'],
    ['Fake-Store.MyShopify.com', 'fake-store.myshopify.com'],
    ['  a1.myshopify.com ', 'a1.myshopify.com'],
  ])('S08 AS-01: accepts %j', (input, domain) => {
    expect(validateShopifyDomain(input)).toEqual({ ok: true, domain });
  });

  it.each([
    'evil.com',
    'evil.com/.myshopify.com',
    'x.myshopify.com:443',
    'https://x.myshopify.com',
    'x.myshopify.com/path',
    '-x.myshopify.com',
    '.myshopify.com',
    'x.y.myshopify.com',
    'x.myshopify.com.evil.com',
    'x@evil.com#.myshopify.com',
    '',
    `${'a'.repeat(250)}.myshopify.com`,
  ])('S08 AS-01: rejects %j', (input) => {
    expect(validateShopifyDomain(input)).toMatchObject({ ok: false });
  });
});
