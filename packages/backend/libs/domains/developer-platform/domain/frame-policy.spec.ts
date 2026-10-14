import {
  buildEmbedCsp,
  buildFrameAncestors,
  FRAME_ANCESTORS_NONE,
} from './frame-policy';

const NONCE = 'q83Ym2uJ0pT4wZc9vK1xRg==';

describe('S44 AS-38 frame-ancestors builder', () => {
  it('S44 AS-38: one origin', () => {
    expect(buildFrameAncestors(['https://a.example'])).toBe(
      'https://a.example',
    );
  });

  it('S44 AS-38: ten origins in random order come out sorted, once each', () => {
    const origins = Array.from(
      { length: 10 },
      (_, i) => `https://s${i}.example`,
    );
    const shuffled = [...origins].reverse();
    shuffled.push(origins[3], origins[3]);
    expect(buildFrameAncestors(shuffled)).toBe(origins.join(' '));
  });

  it('S44 AS-38: an origin with a port is kept as is', () => {
    expect(
      buildFrameAncestors([
        'https://shop.example:8443',
        'https://www.my-shop.com',
      ]),
    ).toBe('https://shop.example:8443 https://www.my-shop.com');
  });

  it.each([
    [[], 'empty list'],
    [['https://Shop.com'], 'not normalised'],
    [['https://shop.com:443'], 'not normalised (default port)'],
    [['https://shop.com/path'], 'path'],
    [['https://a.example https://evil.example'], 'whitespace'],
    [['https://a.example;'], 'semicolon'],
    [['https://a.example,https://b.example'], 'comma'],
    [["https://a.example'"], 'quote'],
    [['https://a.example"'], 'double quote'],
    [['https://a.example\n'], 'control character'],
    [['*'], 'wildcard'],
    [['https:'], 'scheme source'],
    [["'self'"], 'keyword'],
  ] as [string[], string][])('S44 AS-38: throws for %j (%s)', (origins) => {
    expect(() => buildFrameAncestors(origins)).toThrow();
  });
});

describe('S44 AS-34 embed CSP assembly', () => {
  const csp = buildEmbedCsp({
    nonce: NONCE,
    origins: ['https://www.my-shop.com', 'https://shop.example:8443'],
  });
  const directive = (name: string): string | undefined =>
    csp.split('; ').find((d) => d === name || d.startsWith(`${name} `));

  it('S44 AS-34: carries every directive of FR-025', () => {
    expect(directive('default-src')).toBe("default-src 'none'");
    expect(directive('script-src')).toBe(
      `script-src 'nonce-${NONCE}' 'strict-dynamic'`,
    );
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('form-action')).toBe("form-action 'self'");
    expect(directive('frame-ancestors')).toBe(
      'frame-ancestors https://shop.example:8443 https://www.my-shop.com',
    );
  });

  it('S44 AS-34: none of the forbidden tokens appears in script-src', () => {
    const script = directive('script-src') ?? '';
    for (const forbidden of [
      "'unsafe-inline'",
      "'unsafe-eval'",
      '*',
      'data:',
      'https:',
      'http:',
    ])
      expect(script).not.toContain(forbidden);
  });

  it('S44 AS-34: refuses a nonce that is too short or not base64', () => {
    const origins = ['https://a.example'];
    expect(() => buildEmbedCsp({ nonce: 'short', origins })).toThrow();
    expect(() =>
      buildEmbedCsp({ nonce: "abc'; script-src *", origins }),
    ).toThrow();
  });

  it('S44 AS-36: the default for every other response refuses framing', () => {
    expect(FRAME_ANCESTORS_NONE).toBe("frame-ancestors 'none'");
  });
});
