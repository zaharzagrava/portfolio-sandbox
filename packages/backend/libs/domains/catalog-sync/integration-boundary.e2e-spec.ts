import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localProfileRule } from '@app/common/config/local-profile-config';
import { validateShopifyDomain } from './domain/store-address';
import { ProviderCallError } from './domain/ports/commerce-provider.port';
import {
  InMemoryBreakerPersistence,
  ProviderHttp,
} from './infra/provider-http';
import { providerNetworkFromAllowList } from './infra/provider-network';
import { ShopifyAdapter } from './infra/shopify.adapter';

const ctx = (values: Record<string, unknown>, production = false) => ({
  get: (key: string) => values[key],
  production,
});

const allowAll = {
  check: () => Promise.resolve({ allowed: true as const }),
  penalize: () => Promise.resolve(),
};

describe('J04 provider host allow-list (G-08, G-26, FR-018)', () => {
  let dir: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'j04-boundary-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    server = createServer(
      {
        key: readFileSync(join(dir, 'key.pem')),
        cert: readFileSync(join(dir, 'cert.pem')),
      },
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const stack = (origin: string, allowed: string[]) =>
    new ProviderHttp({
      provider: 'shopify',
      policy: 'integrations.shopify',
      credentialId: 'cred-1',
      origin,
      apiPath: '/admin/api/2025-07',
      limiter: allowAll as never,
      breaker: new InMemoryBreakerPersistence(),
      sleep: () => Promise.resolve(),
      unsafeTestNetwork:
        providerNetworkFromAllowList(allowed).unsafeTestNetwork,
    });

  it('J04 G-08: a listed host:port is a valid shop domain and the adapter builds its origin; an unlisted host:port is not', () => {
    const listed = `127.0.0.1:${port}`;
    expect(validateShopifyDomain(listed, [listed])).toEqual({
      ok: true,
      domain: listed,
    });
    expect(validateShopifyDomain(`127.0.0.1:${port + 1}`, [listed]).ok).toBe(
      false,
    );
    expect(validateShopifyDomain('127.0.0.2:9', [listed]).ok).toBe(false);
    // Today's behaviour without the list.
    expect(validateShopifyDomain(listed).ok).toBe(false);
    expect(validateShopifyDomain('acme.myshopify.com', [listed]).ok).toBe(true);
    const adapter = new ShopifyAdapter({
      appKey: 'k',
      appSecret: 's',
      apiVersion: '2025-07',
    });
    expect(adapter.apiTarget(listed).origin).toBe(`https://${listed}`);
  });

  it('J04 G-08: with the list set the Shopify call stack reaches that host:port over HTTPS', async () => {
    const response = await stack(`https://127.0.0.1:${port}`, [
      `127.0.0.1:${port}`,
    ]).call({ method: 'GET', path: '/products.json', idempotent: true });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
  });

  it("J04 G-08: any other loopback host stays refused by the SSRF guard, and an empty list is today's behaviour", async () => {
    const listed = [`127.0.0.1:${port}`];
    await expect(
      stack(`https://127.0.0.2:${port}`, listed).call({
        method: 'GET',
        path: '/products.json',
        idempotent: true,
      }),
    ).rejects.toMatchObject({ kind: 'blocked_address' });
    const refused = stack(`https://127.0.0.1:${port}`, []).call({
      method: 'GET',
      path: '/products.json',
      idempotent: true,
    });
    await expect(refused).rejects.toBeInstanceOf(ProviderCallError);
    expect(providerNetworkFromAllowList([])).toEqual({});
  });

  it('J04 G-08: the list is host:port only and startup refuses it in production', () => {
    expect(
      localProfileRule(ctx({ allowed_provider_hosts: `127.0.0.1:${port}` })),
    ).toEqual([]);
    expect(
      localProfileRule(ctx({ allowed_provider_hosts: 'localhost' })),
    ).toEqual(
      expect.arrayContaining([
        'allowed_provider_hosts entries must be host:port',
      ]),
    );
    expect(
      localProfileRule(
        ctx({ allowed_provider_hosts: `127.0.0.1:${port}` }, true),
      ),
    ).toEqual(
      expect.arrayContaining([
        'allowed_provider_hosts must not be set in production',
      ]),
    );
  });
});
