import { startStandIn, StandIn } from '@app/test/toolkit/stand-in-server';
import { HostResolver } from './ssrf-guard';
import { safeGet, safeRequest } from './pinned-request';
import { SafeRequestError } from './safe-request-error';

const PUBLIC = '93.184.216.34';
const PUBLIC_B = '93.184.216.35';

describe('safe outbound requests (SSRF)', () => {
  let shop: StandIn;
  let other: StandIn;

  beforeAll(async () => {
    shop = await startStandIn({
      tlsHosts: ['shop.example', 'redirect.example'],
    });
    other = await startStandIn({ tlsHosts: ['other.example'] });
  });
  afterAll(async () => {
    await Promise.all([shop.close(), other.close()]);
  });
  let connectionsBefore = 0;
  beforeEach(() => {
    connectionsBefore = shop.connections; // "0 connections" means: none made by the call under test
    shop.requests.length = 0;
    shop.setHandler(
      (_req, res) =>
        void res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<h1>hello</h1>'),
    );
  });

  /** shop.example → PUBLIC (served by `shop`), other.example → PUBLIC_B (served by `other`), private.example → 10.0.0.1. */
  const hosts: Record<string, string> = {
    'shop.example': PUBLIC,
    'redirect.example': PUBLIC,
    'other.example': PUBLIC_B,
    'private.example': '10.0.0.1',
  };
  const resolver: HostResolver & jest.Mock = jest.fn(async (host: string) => {
    if (!hosts[host])
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
        code: 'ENOTFOUND',
      });
    return [{ address: hosts[host], family: 4 as const }];
  });
  const testTransport = () => ({
    ca: [shop.ca!, other.ca!].join('\n'),
    mapAddress: (address: string, _port: number) =>
      address === PUBLIC
        ? { address: '127.0.0.1', port: shop.port }
        : address === PUBLIC_B
          ? { address: '127.0.0.1', port: other.port }
          : { address, port: _port },
  });
  const base = {
    userAgent: 'toolkit-test',
    resolver,
    get testTransport() {
      return testTransport(); // lazily: the stand-ins exist only after beforeAll
    },
  };
  beforeEach(() => resolver.mockClear());

  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e) => e,
    );
    expect(error).toBeInstanceOf(SafeRequestError);
    return error as SafeRequestError;
  };

  it('S54 AS-104: safeGet returns status, headers, body, snippet, truncated, finalUrl, redirects and durationMs', async () => {
    const result = await safeGet('https://shop.example/page', base);
    expect(result).toMatchObject({
      status: 200,
      body: '<h1>hello</h1>',
      snippet: '<h1>hello</h1>',
      truncated: false,
      finalUrl: 'https://shop.example/page',
      redirects: 0,
    });
    expect(result.headers['content-type']).toBe('text/html');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

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
  ])(
    'S54 AS-105: a host resolving to %s fails blocked_address with 0 connections',
    async (address) => {
      const r: HostResolver = async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ];
      const error = await failure(
        safeGet('https://shop.example/', { ...base, resolver: r }),
      );
      expect(error.kind).toBe('blocked_address');
      expect(shop.connections).toBe(connectionsBefore);
    },
  );

  it.each([
    ['https://2130706433/'],
    ['https://0x7f.0.0.1/'],
    ['https://[::1]/'],
    ['https://localhost/'],
    ['https://LOCALHOST./'],
  ])(
    'S54 AS-105: the literal %s fails blocked_address with 0 connections',
    async (url) => {
      const error = await failure(safeGet(url, base));
      expect(error.kind).toBe('blocked_address');
      expect(shop.connections).toBe(connectionsBefore);
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it('S54 AS-106: a public and a private answer together fail blocked_address', async () => {
    const mixed: HostResolver = async () => [
      { address: PUBLIC, family: 4 },
      { address: '10.0.0.2', family: 4 },
    ];
    expect(
      (
        await failure(
          safeGet('https://shop.example/', { ...base, resolver: mixed }),
        )
      ).kind,
    ).toBe('blocked_address');
    expect(shop.connections).toBe(connectionsBefore);
  });

  it('S54 AS-107: the connection is pinned to the first answer, one lookup per hop, certificate checked against the host name', async () => {
    let lookups = 0;
    const rebinding: HostResolver = async () => [
      { address: lookups++ === 0 ? PUBLIC : '127.0.0.1', family: 4 },
    ];
    const result = await safeGet('https://shop.example/pinned', {
      ...base,
      resolver: rebinding,
    });
    expect(result.status).toBe(200);
    expect(lookups).toBe(1);
    expect(shop.requests.at(-1)!.headers.host).toBe('shop.example');
  });

  describe('AS-108 redirects', () => {
    beforeEach(() => {
      shop.setHandler((req, res) => {
        const url = new URL(req.url!, 'https://shop.example');
        const chain = /^\/chain\/(\d+)$/.exec(url.pathname);
        if (chain)
          return void res
            .writeHead(302, { location: `/chain/${Number(chain[1]) + 1}` })
            .end();
        if (url.pathname === '/to-other')
          return void res
            .writeHead(302, { location: 'https://other.example/landing' })
            .end();
        if (url.pathname === '/to-private')
          return void res
            .writeHead(302, { location: 'https://private.example/admin' })
            .end();
        if (url.pathname === '/to-sibling')
          return void res
            .writeHead(302, { location: 'https://redirect.example/landing' })
            .end();
        if (url.pathname === '/start')
          return void res.writeHead(302, { location: '/landing' }).end();
        res.writeHead(200, { 'content-type': 'text/html' }).end('landed');
      });
    });

    it('refuses a redirect by default', async () => {
      expect(
        (await failure(safeGet('https://shop.example/start', base))).kind,
      ).toBe('redirect_refused');
    });

    it('follows a same-host redirect, re-checking the address, and counts it', async () => {
      const result = await safeGet('https://shop.example/start', {
        ...base,
        maxRedirects: 2,
        sameHostRedirectsOnly: true,
      });
      expect(result).toMatchObject({
        status: 200,
        body: 'landed',
        redirects: 1,
        finalUrl: 'https://shop.example/landing',
      });
      expect(resolver).toHaveBeenCalledTimes(2); // once per hop
    });

    it('fails redirected_host when the redirect leaves the host and only same-host is allowed', async () => {
      expect(
        (
          await failure(
            safeGet('https://shop.example/to-other', {
              ...base,
              maxRedirects: 2,
              sameHostRedirectsOnly: true,
            }),
          )
        ).kind,
      ).toBe('redirected_host');
      expect(
        (
          await failure(
            safeGet('https://shop.example/to-sibling', {
              ...base,
              maxRedirects: 2,
              sameHostRedirectsOnly: true,
            }),
          )
        ).kind,
      ).toBe('redirected_host');
    });

    it('follows to another host when allowed, and still blocks a redirect to a private host', async () => {
      other.setHandler(
        (_req, res) =>
          void res
            .writeHead(200, { 'content-type': 'text/html' })
            .end('other landed'),
      );
      const followed = await safeGet('https://shop.example/to-other', {
        ...base,
        maxRedirects: 2,
        sameHostRedirectsOnly: false,
      });
      expect(followed).toMatchObject({
        status: 200,
        body: 'other landed',
        redirects: 1,
        finalUrl: 'https://other.example/landing',
      });
      expect(
        (
          await failure(
            safeGet('https://shop.example/to-private', {
              ...base,
              maxRedirects: 2,
              sameHostRedirectsOnly: false,
            }),
          )
        ).kind,
      ).toBe('blocked_address');
    });

    it('fails too_many_redirects on the redirect past the limit', async () => {
      const error = await failure(
        safeGet('https://shop.example/chain/0', {
          ...base,
          maxRedirects: 2,
          sameHostRedirectsOnly: true,
        }),
      );
      expect(error.kind).toBe('too_many_redirects');
      expect(shop.requests.length).toBe(3);
    });
  });

  it('S54 AS-111: the overall deadline beats a slow drip', async () => {
    shop.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const timer = setInterval(() => res.write('x'), 200);
      res.on('close', () => clearInterval(timer));
    });
    const started = Date.now();
    const error = await failure(
      safeGet('https://shop.example/drip', {
        ...base,
        requestDeadlineMs: 1_000,
      }),
    );
    expect(error.kind).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('S54 AS-111: a body over maxBytes is truncated, not a failure', async () => {
    shop.setHandler(
      (_req, res) =>
        void res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(Buffer.alloc(3 * 1024 * 1024, 'a')),
    );
    const result = await safeGet('https://shop.example/big', {
      ...base,
      maxBytes: 1024 * 1024,
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(1024 * 1024);
    expect(result.status).toBe(200);
  });

  it('S54 AS-112: a content type outside the allow-list fails unsupported_content_type', async () => {
    shop.setHandler(
      (_req, res) =>
        void res
          .writeHead(200, { 'content-type': 'application/octet-stream' })
          .end(Buffer.alloc(1024, 1)),
    );
    expect(
      (
        await failure(
          safeGet('https://shop.example/bin', {
            ...base,
            allowedContentTypes: ['text/html'],
          }),
        )
      ).kind,
    ).toBe('unsupported_content_type');
    shop.setHandler(
      (_req, res) =>
        void res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end('fine'),
    );
    expect(
      (
        await safeGet('https://shop.example/html', {
          ...base,
          allowedContentTypes: ['text/html'],
        })
      ).body,
    ).toBe('fine');
  });

  it('S54 AS-113: a certificate for another host name fails tls_error', async () => {
    const mismatched = {
      ...base,
      testTransport: {
        ...testTransport(),
        mapAddress: () => ({ address: '127.0.0.1', port: other.port }),
      },
    };
    expect(
      (await failure(safeGet('https://shop.example/', mismatched))).kind,
    ).toBe('tls_error');
  });

  it('S54 AS-114: unresolvable and network_error, with no address, stack or response text in the message', async () => {
    const missing = await failure(safeGet('https://nowhere.example/', base));
    expect(missing.kind).toBe('unresolvable');
    shop.setHandler((req) => void req.socket.destroy());
    const reset = await failure(safeGet('https://shop.example/', base));
    expect(reset.kind).toBe('network_error');
    for (const error of [missing, reset]) {
      expect(error.message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(error.message).not.toMatch(/ECONN|ENOTFOUND|getaddrinfo|\bat \w/);
      expect(error.message).not.toContain('nowhere.example');
    }
  });

  it('S54 AS-115: safeRequest POST sends the exact body and headers, returns a snippet and does not follow a 3xx', async () => {
    shop.setHandler(
      (_req, res) =>
        void res
          .writeHead(201, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, pad: 'p'.repeat(3_000) })),
    );
    const body = JSON.stringify({ event: 'order.paid', n: 7 });
    const result = await safeRequest({
      method: 'POST',
      url: 'https://shop.example/hook',
      headers: { 'content-type': 'application/json', 'x-signature': 'sig-1' },
      body,
      timeoutMs: 2_000,
      maxResponseBytes: 64 * 1024,
      allowedPorts: [443],
      followRedirects: false,
      resolver,
      testTransport: testTransport(),
    });
    const seen = shop.requests.at(-1)!;
    expect(seen.method).toBe('POST');
    expect(seen.body.toString()).toBe(body);
    expect(seen.headers['x-signature']).toBe('sig-1');
    expect(result.status).toBe(201);
    expect(Buffer.byteLength(result.snippet)).toBeLessThanOrEqual(1024);
    expect(result.snippet.startsWith('{"ok":true')).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    shop.setHandler(
      (_req, res) =>
        void res.writeHead(302, { location: 'https://other.example/' }).end(),
    );
    const redirected = await safeRequest({
      method: 'POST',
      url: 'https://shop.example/hook',
      body,
      timeoutMs: 2_000,
      maxResponseBytes: 1024,
      allowedPorts: [443],
      followRedirects: false,
      resolver,
      testTransport: testTransport(),
    });
    expect(redirected).toMatchObject({ status: 302, redirects: 0 });
  });
});
