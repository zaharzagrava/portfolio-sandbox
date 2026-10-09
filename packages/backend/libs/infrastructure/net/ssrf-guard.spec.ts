import { isPublicAddress, resolvePublicAddress } from './ssrf-guard';
import { parseSafeUrl } from './safe-url';
import { SafeRequestError } from './safe-request-error';

/** Shared by webhooks (SD-30), the crawler (SD-35) and shop integrations (SD-36). */
describe('SSRF guard (U-SSRF)', () => {
  it.each([
    ['127.0.0.1', false],
    ['10.0.0.1', false],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false], // cloud metadata
    ['100.64.0.1', false], // carrier-grade NAT
    ['0.0.0.0', false],
    ['224.0.0.1', false], // multicast
    ['198.18.0.1', false], // benchmarking
    ['255.255.255.255', false],
    ['::1', false],
    ['::', false],
    ['fc00::1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['ff02::1', false],
    ['::ffff:127.0.0.1', false], // v4-mapped, dotted
    ['::ffff:7f00:1', false], // v4-mapped, as the URL parser prints it
    ['::ffff:10.0.0.1', false],
    ['64:ff9b::7f00:1', false], // NAT64 to loopback
    ['2002:7f00:1::1', false], // 6to4 of 127.0.0.1
    ['::127.0.0.1', false], // v4-compatible
    ['2001:db8::1', false], // documentation
    ['8.8.8.8', true],
    ['172.32.0.1', true], // just outside 172.16/12
    ['100.128.0.1', true], // just outside 100.64/10
    ['93.184.216.34', true],
    ['2606:4700:4700::1111', true],
    ['::ffff:8.8.8.8', true],
    ['not-an-ip', false],
  ])('AS-105: %s public=%s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  const publicResolver = async () => [
    { address: '93.184.216.34', family: 4 as const },
  ];

  it.each([
    ['http://2130706433/', 'decimal'],
    ['https://2130706433/', 'decimal https'],
    ['https://0x7f.0.0.1/', 'hex'],
    ['https://0177.0.0.1/', 'octal'],
    ['https://127.1/', 'short'],
    ['https://0/', 'zero'],
    ['https://[::1]/', 'ipv6 loopback'],
    ['https://[::ffff:127.0.0.1]/', 'ipv4-mapped'],
    ['https://localhost/', 'localhost'],
    ['https://LOCALHOST./', 'trailing dot'],
    ['https://api.localhost/', 'localhost subdomain'],
  ])(
    'AS-105: the literal %s (%s) is blocked_address and never resolved',
    async (raw) => {
      const resolver = jest.fn(publicResolver);
      const url = new URL(raw);
      // `http://` literals are rejected as invalid_url by parseSafeUrl; the guard must still block them when allowed.
      await expect(
        resolvePublicAddress(url.hostname, { resolver }),
      ).rejects.toMatchObject({ kind: 'blocked_address' });
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['127.0.0.1'],
    ['10.0.0.1'],
    ['172.16.0.1'],
    ['192.168.1.1'],
    ['169.254.169.254'],
    ['100.64.0.1'],
    ['0.0.0.0'],
    ['224.0.0.1'],
    ['198.18.0.1'],
    ['::1'],
    ['fc00::1'],
    ['fe80::1'],
    ['::ffff:127.0.0.1'],
  ])('AS-105: a host resolving to %s is blocked_address', async (address) => {
    const resolver = async () => [
      { address, family: address.includes(':') ? (6 as const) : (4 as const) },
    ];
    await expect(
      resolvePublicAddress('shop.example', { resolver }),
    ).rejects.toMatchObject({ kind: 'blocked_address' });
  });

  it('AS-106: one private address among public ones blocks the host', async () => {
    const resolver = async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '10.0.0.5', family: 4 as const },
    ];
    await expect(
      resolvePublicAddress('shop.example', { resolver }),
    ).rejects.toMatchObject({ kind: 'blocked_address' });
  });

  it('returns the first address when every address is public', async () => {
    const resolver = async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '2606:4700:4700::1111', family: 6 as const },
    ];
    await expect(
      resolvePublicAddress('shop.example', { resolver }),
    ).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('an unresolvable host is "unresolvable" and an empty answer too', async () => {
    await expect(
      resolvePublicAddress('nope.example', {
        resolver: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND nope.example'), {
            code: 'ENOTFOUND',
          });
        },
      }),
    ).rejects.toMatchObject({ kind: 'unresolvable' });
    await expect(
      resolvePublicAddress('empty.example', { resolver: async () => [] }),
    ).rejects.toMatchObject({ kind: 'unresolvable' });
  });

  it('allowPrivateHosts lets a listed host through (test escape hatch)', async () => {
    const resolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
    await expect(
      resolvePublicAddress('stand-in.test', {
        resolver,
        allowPrivateHosts: ['stand-in.test'],
      }),
    ).resolves.toEqual({ address: '127.0.0.1', family: 4 });
  });

  it('failure messages never contain the address', async () => {
    const error = await resolvePublicAddress('shop.example', {
      resolver: async () => [{ address: '10.9.8.7', family: 4 as const }],
    }).catch((e) => e);
    expect(error).toBeInstanceOf(SafeRequestError);
    expect(String(error.message)).not.toContain('10.9.8.7');
    expect(String(error.message)).not.toContain('shop.example');
  });

  it('parseSafeUrl is exercised in safe-url.spec.ts', () => {
    expect(parseSafeUrl('https://shop.example/page').hostname).toBe(
      'shop.example',
    );
  });
});
