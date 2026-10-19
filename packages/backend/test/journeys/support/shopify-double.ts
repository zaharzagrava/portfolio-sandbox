import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeShopify } from '@app/infrastructure/http-client/testing/fake-shopify';

/** Default port of the Shopify double; the local stack lists `127.0.0.1:18445` in `ALLOWED_PROVIDER_HOSTS`. */
export const SHOPIFY_DOUBLE_PORT = 18445;

/** The app credentials the dev stack is configured with (`SHOPIFY_APP_KEY` / `SHOPIFY_APP_SECRET`); override for another stack. */
const APP_KEY = process.env.JOURNEY_SHOPIFY_APP_KEY ?? 'dev-shopify-app-key';
const APP_SECRET =
  process.env.JOURNEY_SHOPIFY_APP_SECRET ??
  'dev-shopify-app-secret-ffffffffffffffffffff';

/** One stock write the stack made: "set `set`, expected `expected`" for a variant (`expected` is `null` when unconditional). */
export interface StockWrite {
  variantId: number;
  set: number;
  expected: number | null;
}

export type DoubleAnswer = 200 | 409 | 503 | 'hang';

/**
 * The Shopify double `SD` of J04 (spec.md "Provider doubles"): an HTTPS server owned by the test that speaks the Admin API
 * shapes S08 uses (OAuth token exchange, products with variants, inventory levels, locations, webhook subscriptions) and
 * signs callbacks and webhooks with the app secret. Its `host` (host:port) is the shop domain the install route takes and
 * what the stack's `ALLOWED_PROVIDER_HOSTS` lists. It is a system-edge stand-in: real Shopify is never called.
 *
 * Standard catalogue (`seedStandard`): five products, seven active variants plus one draft product that must be ignored.
 */
export class ShopifyDouble extends FakeShopify {
  private dir = '';
  private stopFault?: () => void;
  /** Milliseconds the stack's clock is ahead of this machine's (the callback timestamp is judged by the stack's clock). */
  clockSkewMs = 0;

  private constructor(readonly host: string) {
    super({
      shopDomain: host,
      // The platform books in one currency (J01, PLATFORM_CURRENCY): a store in another one is refused (currency_mismatch).
      currency: process.env.JOURNEY_CURRENCY ?? 'EUR',
      clientId: APP_KEY,
      clientSecret: APP_SECRET,
      accessToken: 'shpat_journey_double',
    });
  }

  static async startDouble(
    port: number = Number(
      process.env.JOURNEY_SHOPIFY_PORT ?? SHOPIFY_DOUBLE_PORT,
    ),
  ): Promise<ShopifyDouble> {
    const double = new ShopifyDouble(`127.0.0.1:${port}`);
    double.dir = mkdtempSync(join(tmpdir(), 'j04-shopify-'));
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
        join(double.dir, 'key.pem'),
        '-out',
        join(double.dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    await double.start({
      port,
      tls: {
        key: readFileSync(join(double.dir, 'key.pem')),
        cert: readFileSync(join(double.dir, 'cert.pem')),
      },
    });
    return double;
  }

  override async stop(): Promise<void> {
    await super.stop();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = '';
  }

  /** Five products, seven active variants, plus one draft product the stack must ignore. Returns the variant ids by title. */
  seedStandard(token: string): Record<string, number> {
    const mk = (
      title: string,
      price: string,
      stock: number,
      extra: { price?: string; stock?: number }[] = [],
      status: 'active' | 'draft' = 'active',
    ) =>
      this.addProduct({
        title: `${title} ${token}`,
        price,
        stock,
        status,
        extraVariants: extra,
      });
    const a = mk('Shopify Alpha', '12.50', 10);
    const b = mk('Shopify Beta', '8.00', 5, [{ price: '9.00', stock: 4 }]);
    const c = mk('Shopify Gamma', '20.00', 7, [{ price: '21.00', stock: 3 }]);
    const d = mk('Shopify Delta', '5.00', 2);
    const e = mk('Shopify Epsilon', '30.00', 9);
    mk('Shopify Draft', '1.00', 1, [], 'draft');
    return {
      V1: a.variants[0].id,
      V2: b.variants[0].id,
      V3: b.variants[1].id,
      V4: c.variants[0].id,
      V5: c.variants[1].id,
      V6: d.variants[0].id,
      V7: e.variants[0].id,
    };
  }

  /** The seller sells `quantity` units on the Shopify side (no webhook): the remote stock drops, `updated_at` moves. */
  sell(variantId: number, quantity: number): void {
    this.setRemoteStock(variantId, this.stockOf(variantId) - quantity);
  }

  /** Every stock write the stack made, oldest first (successful or not), as "set `set`, expected `expected`". */
  get writeLog(): StockWrite[] {
    const variantOf = new Map<number, number>();
    for (const product of this.allProducts())
      for (const variant of product.variants)
        variantOf.set(variant.inventory_item_id, variant.id);
    return this.stockWrites.map((request) => {
      const body = request.body as {
        inventory_item_id: number;
        available: number;
        change_from_quantity?: number | null;
      };
      return {
        variantId: variantOf.get(body.inventory_item_id) ?? -1,
        set: body.available,
        expected: body.change_from_quantity ?? null,
      };
    });
  }

  /** Scripts the answer to every stock write from now on (`200` = the normal route). `hang` never answers in time. */
  answer(status: DoubleAnswer): void {
    this.stopFault?.();
    this.stopFault = undefined;
    if (status === 200) return;
    const match = (r: { method: string; path: string }) =>
      r.method === 'POST' && /\/inventory_levels\/set\.json$/.test(r.path);
    this.stopFault =
      status === 'hang'
        ? this.inject({ match, fault: { kind: 'delay', ms: 120_000 } })
        : this.inject({
            match,
            fault: { kind: 'status', status, json: { errors: 'scripted' } },
          });
  }

  /** The query string of a signed install callback (what Shopify sends the browser to): `hmac` over the sorted others. */
  signedCallback(state: string, code = 'journey-code'): string {
    const params: Record<string, string> = {
      code,
      shop: this.host,
      state,
      timestamp: String(Math.floor((Date.now() + this.clockSkewMs) / 1000)),
    };
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const hmac = createHmac('sha256', APP_SECRET).update(message).digest('hex');
    return new URLSearchParams({ ...params, hmac }).toString();
  }

  /** Where the stack asked this shop to send webhooks, per topic (registered during the backfill/connect). */
  webhookAddress(topic: string): string | undefined {
    return this.webhookSubscriptions.find((s) => s.topic === topic)?.address;
  }
}
