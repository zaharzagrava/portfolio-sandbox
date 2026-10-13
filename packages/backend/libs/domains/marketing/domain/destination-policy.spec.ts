import {
  assembleRedirectUrl,
  checkDestination,
  DestinationNotAllowedError,
} from './destination-policy';

const FRONT = 'https://shop.example';

describe('S37 AS-03: destination policy (also AS-04 reference removal, AS-25 assembly, SC-005)', () => {
  it.each([
    ['plain http', 'http://shop.example/p/1'],
    ['another host', 'https://evil.example/p/1'],
    ['user-info trick', 'https://shop.example@evil.example/p/1'],
    [
      'user-info with the storefront host after it',
      'https://evil.example@shop.example.evil.example/',
    ],
    ['user-info on the right host', 'https://user:pass@shop.example/p/1'],
    ['backslash trick', 'https://evil.example\\@shop.example/p/1'],
    ['non-default port', 'https://shop.example:8443/p/1'],
    ['trailing dot', 'https://shop.example./p/1'],
    ['look-alike suffix', 'https://shop.example.evil.example/p/1'],
    ['look-alike prefix', 'https://evilshop.example/p/1'],
    ['unrelated subdomain', 'https://admin.shop.example/p/1'],
    ['scheme-relative', '//shop.example/p/1'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>1</script>'],
    ['relative path', '/p/1'],
    ['whitespace inside', 'https://shop.example/p/ 1'],
    ['control character', 'https://shop.example/p/\u0001'],
    ['empty', ''],
  ])('refuses %s', (_name, destination) => {
    expect(() => checkDestination(destination, FRONT)).toThrow(
      DestinationNotAllowedError,
    );
  });

  it('refuses a destination longer than 2,048 characters', () => {
    expect(() =>
      checkDestination(`${FRONT}/${'a'.repeat(2048)}`, FRONT),
    ).toThrow(DestinationNotAllowedError);
  });

  it.each([
    [
      'upper-case host is lowered',
      'HTTPS://SHOP.EXAMPLE/p/1',
      'https://shop.example/p/1',
    ],
    [
      'www form is accepted',
      'https://www.shop.example/p/1',
      'https://www.shop.example/p/1',
    ],
    [
      'explicit default port is dropped',
      'https://shop.example:443/p/1',
      'https://shop.example/p/1',
    ],
  ])('accepts: %s', (_name, destination, expected) => {
    expect(checkDestination(destination, FRONT)).toBe(expected);
  });

  it('normalises an IDNA storefront host', () => {
    expect(
      checkDestination(
        'https://MÜNCHEN.example/p/1',
        'https://xn--mnchen-3ya.example',
      ),
    ).toBe('https://xn--mnchen-3ya.example/p/1');
  });

  it('accepts http only for a localhost storefront (development)', () => {
    expect(
      checkDestination('http://localhost:3000/p/1', 'http://localhost:3000'),
    ).toBe('http://localhost:3000/p/1');
    expect(() => checkDestination('http://shop.example/p/1', FRONT)).toThrow(
      DestinationNotAllowedError,
    );
  });

  describe('reference removal', () => {
    it.each([
      ['only parameter', `${FRONT}/p/1?ref=abc`, `${FRONT}/p/1`],
      [
        'keeps order and encoding',
        `${FRONT}/p/1?b=%20x&ref=abc&a=1+2`,
        `${FRONT}/p/1?b=%20x&a=1+2`,
      ],
      [
        'keeps the fragment',
        `${FRONT}/p/1?ref=abc&a=1#reviews`,
        `${FRONT}/p/1?a=1#reviews`,
      ],
      ['every ref', `${FRONT}/p/1?ref=a&x=1&ref=b`, `${FRONT}/p/1?x=1`],
      [
        'not a prefix match',
        `${FRONT}/p/1?reference=1&ref2=2`,
        `${FRONT}/p/1?reference=1&ref2=2`,
      ],
    ])('%s', (_name, input, expected) => {
      expect(checkDestination(input, FRONT)).toBe(expected);
    });
  });

  describe('assembleRedirectUrl', () => {
    it.each([
      ['no query, no fragment', `${FRONT}/p/1`, `${FRONT}/p/1?ref=aB3dE9x`],
      [
        'with query',
        `${FRONT}/p/1?color=blue`,
        `${FRONT}/p/1?color=blue&ref=aB3dE9x`,
      ],
      [
        'with fragment',
        `${FRONT}/p/1#reviews`,
        `${FRONT}/p/1?ref=aB3dE9x#reviews`,
      ],
      [
        'query and fragment',
        `${FRONT}/p/1?a=%2F&b=1#top`,
        `${FRONT}/p/1?a=%2F&b=1&ref=aB3dE9x#top`,
      ],
    ])('%s', (_name, stored, expected) => {
      expect(assembleRedirectUrl(stored, 'aB3dE9x')).toBe(expected);
    });
  });
});
