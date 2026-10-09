import { parseSafeUrl, SafeRequestConfigError } from './safe-url';

describe('S54 safe URL parsing (U-URL)', () => {
  it.each([
    ['http://shop.example/', 'plain http'],
    ['https://shop.example:8443/', 'port outside the allow-list'],
    ['https://shop.example:80/', 'port 80'],
    ['https://user:pw@shop.example/', 'userinfo'],
    ['https://user@shop.example/', 'username only'],
    ['ftp://shop.example/', 'other scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['gopher://shop.example/', 'gopher'],
    ['not a url', 'garbage'],
    ['', 'empty'],
    ['//shop.example/', 'scheme-relative'],
  ])('AS-109: %s (%s) is invalid_url before any lookup', (raw) => {
    expect(() => parseSafeUrl(raw)).toThrow(
      expect.objectContaining({ kind: 'invalid_url' }),
    );
  });

  it('AS-109: allowedPorts widens the port rule; https on 443 is accepted', () => {
    expect(parseSafeUrl('https://shop.example/a').port).toBe('');
    expect(parseSafeUrl('https://shop.example:443/a').hostname).toBe(
      'shop.example',
    );
    expect(
      parseSafeUrl('https://shop.example:8443/', { allowedPorts: [443, 8443] })
        .port,
    ).toBe('8443');
    expect(() =>
      parseSafeUrl('https://shop.example:8444/', { allowedPorts: [443, 8443] }),
    ).toThrow(expect.objectContaining({ kind: 'invalid_url' }));
  });

  it('the failure message never repeats the URL', () => {
    let error: unknown;
    try {
      parseSafeUrl('https://user:secret@shop.example/');
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(String((error as Error).message)).not.toContain('secret');
    expect(String((error as Error).message)).not.toContain('shop.example');
  });

  describe('AS-110: escape hatches are refused in production', () => {
    it.each([
      [{ allowHttpHosts: ['127.0.0.1'] }],
      [{ allowPrivateHosts: ['127.0.0.1'] }],
      [{ testTransport: {} }],
    ])('%j throws a configuration error with NODE_ENV=production', (hatch) => {
      expect(() =>
        parseSafeUrl('https://shop.example/', {
          ...hatch,
          nodeEnv: 'production',
        }),
      ).toThrow(SafeRequestConfigError);
    });

    it.each([['test'], ['local'], [undefined]])(
      'the same options work with NODE_ENV=%s',
      (nodeEnv) => {
        expect(
          parseSafeUrl('http://127.0.0.1:4567/hook', {
            allowHttpHosts: ['127.0.0.1'],
            allowPrivateHosts: ['127.0.0.1'],
            allowedPorts: [4567],
            nodeEnv,
          }).protocol,
        ).toBe('http:');
      },
    );

    it('empty lists are not an escape hatch', () => {
      expect(() =>
        parseSafeUrl('https://shop.example/', {
          allowHttpHosts: [],
          allowPrivateHosts: [],
          nodeEnv: 'production',
        }),
      ).not.toThrow();
    });
  });
});
