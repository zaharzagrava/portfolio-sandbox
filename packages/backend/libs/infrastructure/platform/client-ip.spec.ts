import { parseTrustedProxies, resolveClientIp } from './client-ip';

describe('client address resolution (U-IP)', () => {
  it.each([
    [
      'none: the forwarding header is ignored',
      'none',
      '203.0.113.9',
      '1.2.3.4',
      '203.0.113.9',
    ],
    [
      'untrusted peer: a spoofed header is ignored',
      '10.0.0.0/8',
      '203.0.113.9',
      '1.2.3.4',
      '203.0.113.9',
    ],
    ['trusted peer, one hop', '10.0.0.0/8', '10.0.0.2', '5.5.5.5', '5.5.5.5'],
    [
      'trusted peer, forged leftmost value is ignored',
      '10.0.0.0/8',
      '10.0.0.2',
      '6.6.6.6, 9.9.9.9, 10.0.0.7',
      '9.9.9.9',
    ],
    [
      'a single exact address as the proxy list',
      '10.0.0.1',
      '10.0.0.1',
      '5.5.5.5',
      '5.5.5.5',
    ],
    [
      'a CIDR list',
      '192.168.0.0/16, 10.0.0.0/8',
      '192.168.1.1',
      '7.7.7.7, 10.1.1.1',
      '7.7.7.7',
    ],
    [
      'malformed header falls back to the peer',
      '10.0.0.0/8',
      '10.0.0.2',
      'garbage, 10.0.0.7',
      '10.0.0.2',
    ],
    [
      'an empty element is malformed',
      '10.0.0.0/8',
      '10.0.0.2',
      '1.1.1.1,,10.0.0.7',
      '10.0.0.2',
    ],
    ['no header: the peer', '10.0.0.0/8', '10.0.0.2', undefined, '10.0.0.2'],
    [
      'IPv4-mapped IPv6 in the header is normalised',
      '10.0.0.0/8',
      '10.0.0.2',
      '::ffff:9.9.9.9',
      '9.9.9.9',
    ],
    [
      'IPv4-mapped IPv6 peer is normalised and trusted',
      '10.0.0.0/8',
      '::ffff:10.0.0.2',
      '8.8.8.8',
      '8.8.8.8',
    ],
    [
      'IPv6 client behind an IPv6 proxy range',
      'fd00::/8',
      'fd00::1',
      '2001:db8::1',
      '2001:db8::1',
    ],
    [
      'IPv6 untrusted peer',
      'fd00::/8',
      '2001:db8::5',
      '2001:db8::1',
      '2001:db8::5',
    ],
    [
      'every hop trusted: the leftmost address',
      '10.0.0.0/8',
      '10.0.0.2',
      '10.0.0.5, 10.0.0.7',
      '10.0.0.5',
    ],
  ])('S54 AS-136: %s', (_label, proxies, peer, header, expected) => {
    expect(
      resolveClientIp({
        peer,
        forwardedFor: header,
        trustedProxies: parseTrustedProxies(proxies),
      }),
    ).toBe(expected);
  });

  it('S54 AS-136: a repeated header (array form) is read as one comma-joined list', () => {
    expect(
      resolveClientIp({
        peer: '10.0.0.2',
        forwardedFor: ['6.6.6.6', '9.9.9.9'],
        trustedProxies: parseTrustedProxies('10.0.0.0/8'),
      }),
    ).toBe('9.9.9.9');
  });

  it.each(['10.0.0.0/33', 'not-an-ip', '10.0.0.0/', '1.2.3'])(
    'S54 AS-136: the proxy setting %j is rejected',
    (value) => {
      expect(() => parseTrustedProxies(value)).toThrow();
    },
  );
});
