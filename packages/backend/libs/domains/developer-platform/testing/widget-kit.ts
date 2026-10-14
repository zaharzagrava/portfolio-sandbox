import type { INestApplication } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { FakeClock } from '@app/common/core/clock';
import { ProductQueryService } from '@app/domains/catalog';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { WidgetCatalog, type ProductFact } from '../domain/widget-ports';
import { CatalogWidgetCatalog } from '../infra/widget-adapters';
import { WidgetModule } from '../widget.module';
import { WidgetProjectorModule } from '../widget-projector.module';
import {
  clearRateLimits,
  exec,
  fastStoreOf,
  outboxEvents,
  rows,
  waitFor,
} from './public-api-kit';

export { clearRateLimits, exec, fastStoreOf, outboxEvents, rows, waitFor };
export type { TestUser };

/** The frozen instant every widget spec starts from; time moves only through `advance`. */
export const FROZEN_NOW = new Date('2026-10-06T12:00:00.000Z');

export const ORIGIN = 'https://www.my-shop.com';
export const ORIGIN_2 = 'https://shop.example:8443';

type Agent = ReturnType<typeof supertest>;

/** Switches for the one fault the plan injects at the module boundary (AS-21): the product lookup. */
export interface WidgetFaults {
  catalogDown: boolean;
  /** Counts the batch calls the widget made to the catalog (AS-14: exactly one R1 batch). */
  catalogCalls: { ids: string[]; shopId: string }[];
}

class FaultableCatalog extends WidgetCatalog {
  constructor(
    private readonly inner: WidgetCatalog,
    private readonly faults: WidgetFaults,
  ) {
    super();
  }

  async productsOfShop(
    shopId: string,
    ids: string[],
  ): Promise<Map<string, ProductFact>> {
    this.faults.catalogCalls.push({ ids, shopId });
    if (this.faults.catalogDown) throw new Error('catalog is down');
    return this.inner.productsOfShop(shopId, ids);
  }
}

export interface WidgetWorld {
  shop: { id: string; name: string };
  owner: TestUser;
  admin: TestUser;
  staff: TestUser;
  viewer: TestUser;
  outsider: TestUser;
}

export interface WidgetInstance {
  app: INestApplication;
  http(): Agent;
  close(): Promise<void>;
}

export interface CreatedSite {
  id: string;
  shopId: string;
  publishableKey: string;
  identitySecret: string;
  allowedOrigins: string[];
  featuredProductIds: string[];
  version: number;
  [field: string]: unknown;
}

export interface WidgetKit extends CatalogTestApp {
  faults: WidgetFaults;
  /** Moves the clock of every running instance. */
  advance(ms: number): void;
  setNow(at: Date): void;
  /** Another copy of the application over the same database and Redis (instance 2 of AS-20). */
  instance(): Promise<WidgetInstance>;
  /** A shop with one user of each role (every spec creates its own world, L-005, L-006). */
  world(options?: {
    shopStatus?: 'ACTIVE' | 'SUSPENDED' | 'DELETING';
  }): Promise<WidgetWorld>;
  /** `POST /api/shops/:id/products` as the owner; returns the product id and its facts. */
  product(
    world: WidgetWorld,
    body?: Partial<{ title: string; priceMinor: number; quantity: number }>,
  ): Promise<{
    id: string;
    title: string;
    priceMinor: number;
    quantity: number;
  }>;
  archive(world: WidgetWorld, productId: string): Promise<void>;
  /** `POST /api/shops/:id/widget/sites` as the owner. */
  site(
    world: WidgetWorld,
    body?: Partial<{
      name: string;
      origins: string[];
      featuredProductIds: string[];
    }>,
  ): Promise<CreatedSite>;
  /** `signWidgetHandoff` with the kit's clock. */
  handoff(
    site: Pick<CreatedSite, 'publishableKey' | 'identitySecret'>,
    claims?: Record<string, unknown>,
    secret?: string,
  ): string;
  /** A request with the cookie credential of `user` and a valid CSRF token (S01), for AS-13. */
  cookieSession(user: TestUser): { cookie: string; csrf: string };
}

/**
 * The CSRF token S01 issues for a session (S01 FR-051, `random.mac` with the MAC over `csrf:<sid>:<random>`), rebuilt
 * here because identity exports no issuer; a spec needs a valid one to prove the dashboard accepts it (AS-13).
 */
function csrfTokenFor(secret: string, sessionId: string): string {
  const random = randomBytes(24).toString('base64url');
  const mac = createHmac('sha256', secret)
    .update(`csrf:${sessionId}:${random}`)
    .digest()
    .toString('base64url');
  return `${random}.${mac}`;
}

/** Test-only signer of a shop's hand-off token (the production code never signs one). */
export function signWidgetHandoff(
  secret: string,
  claims: Record<string, unknown>,
  options: jwt.SignOptions = {},
): string {
  // no automatic `iat`: it would carry the wall clock, and the app runs on the frozen test clock
  return jwt.sign(claims, secret, {
    algorithm: 'HS256',
    noTimestamp: true,
    ...options,
  });
}

/**
 * The real app the S44 specs run against: the dashboard and public widget routes (`WidgetModule`, prefix `/api`, real
 * sessions and tenancy) with the projector consumers' classes listed as providers (a spec calls `project` directly), over
 * real Postgres, Redis and DynamoDB Local with the production pipe, filter, helmet, CORS policy and limiter. Faked only
 * at system edges: the clock (shared by every instance) and the catalog lookup's failure switch.
 */
export async function createWidgetKit(
  options: { env?: Record<string, string> } = {},
): Promise<WidgetKit> {
  const faults: WidgetFaults = { catalogDown: false, catalogCalls: [] };
  const clocks: FakeClock[] = [];
  const instances: CatalogTestApp[] = [];

  const boot = async (): Promise<CatalogTestApp> => {
    const t = await createCatalogApp({
      extraImports: [WidgetModule, WidgetProjectorModule],
      env: options.env,
      customize: (builder) =>
        builder.overrideProvider(WidgetCatalog).useFactory({
          factory: (products: ProductQueryService) =>
            new FaultableCatalog(new CatalogWidgetCatalog(products), faults),
          inject: [ProductQueryService],
        }),
    });
    t.clock.set(FROZEN_NOW);
    clocks.push(t.clock);
    return t;
  };

  const base = await boot();
  let userCounter = 0;

  const kit: WidgetKit = {
    ...base,
    faults,
    advance(ms) {
      for (const c of clocks) c.set(new Date(c.now().getTime() + ms));
    },
    setNow(at) {
      for (const c of clocks) c.set(at);
    },
    async instance() {
      const other = await boot();
      instances.push(other);
      return {
        app: other.app,
        http: other.http,
        close: () => other.close(),
      };
    },
    async world(opts = {}) {
      const owner = await base.newUser({
        email: `owner-${++userCounter}-${uuidv4()}@example.com`,
      });
      const admin = await base.newUser();
      const staff = await base.newUser();
      const viewer = await base.newUser();
      const outsider = await base.newUser();
      const shop = await createShop(base.app, owner, {
        status: opts.shopStatus ?? 'ACTIVE',
        name: 'My Shop',
      });
      await addMember(base.app, shop.id, admin.id, 'ADMIN');
      await addMember(base.app, shop.id, staff.id, 'STAFF');
      await addMember(base.app, shop.id, viewer.id, 'VIEWER');
      return {
        shop: { id: shop.id, name: shop.name },
        owner,
        admin,
        staff,
        viewer,
        outsider,
      };
    },
    async product(world, body = {}) {
      const payload = {
        title: body.title ?? `Earbuds ${uuidv4().slice(0, 8)}`,
        description: 'Wireless',
        brand: 'Nord',
        category: 'audio',
        priceMinor: body.priceMinor ?? 12_900,
        quantity: body.quantity ?? 3,
        tags: ['audio'],
      };
      const res = await base
        .as(world.owner)
        .post(`/api/shops/${world.shop.id}/products`)
        .send(payload);
      if (res.status !== 201)
        throw new Error(`product: ${res.status} ${JSON.stringify(res.body)}`);
      return {
        id: res.body.id as string,
        title: payload.title,
        priceMinor: payload.priceMinor,
        quantity: payload.quantity,
      };
    },
    async archive(world, productId) {
      const read = await base
        .as(world.owner)
        .get(`/api/shops/${world.shop.id}/products/${productId}`);
      const res = await base
        .as(world.owner)
        .post(`/api/shops/${world.shop.id}/products/${productId}/archive`)
        .send({ expectedVersion: read.body.version });
      if (res.status !== 200)
        throw new Error(`archive: ${res.status} ${JSON.stringify(res.body)}`);
    },
    async site(world, body = {}) {
      const res = await base
        .as(world.owner)
        .post(`/api/shops/${world.shop.id}/widget/sites`)
        .send({ origins: [ORIGIN, ORIGIN_2], ...body });
      if (res.status !== 201)
        throw new Error(`site: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as CreatedSite;
    },
    handoff(site, claims = {}, secret) {
      const now = Math.floor(base.clock.now().getTime() / 1000);
      return signWidgetHandoff(secret ?? site.identitySecret, {
        iss: site.publishableKey,
        aud: 'marketplace-widget',
        sub: 'cust-42',
        email: 'buyer@example.com',
        jti: uuidv4(),
        exp: now + 120,
        ...claims,
      });
    },
    cookieSession(user) {
      const token = user.bearer.replace(/^Bearer /, '');
      const secret = base.app.get(ApiConfigService).get('jwt_secret');
      const csrf = csrfTokenFor(secret, user.sessionId);
      return {
        cookie: `__Host-access=${token}; __Host-csrf=${csrf}`,
        csrf,
      };
    },
    async reset() {
      await base.reset();
      for (const c of clocks) c.set(FROZEN_NOW);
      faults.catalogDown = false;
      faults.catalogCalls.length = 0;
      await clearRateLimits(base.app);
    },
    async close() {
      await Promise.all(instances.map((i) => i.close()));
      await base.close();
    },
  };
  return kit;
}

/**
 * Ends a fault that denied keys of the fast store (`fastStoreOf(...).deny`) and waits until the limiter has noticed:
 * its breaker keeps refusing for `breakerOpenMs` of the injected clock after a failure, so the clock moves past it, and a
 * spec must not leak the open breaker into the next one (L-013).
 */
export async function restoreFastStore(kit: WidgetKit): Promise<void> {
  await fastStoreOf(kit.app).allow();
  kit.advance(120_000);
  await clearRateLimits(kit.app);
  await waitFor(
    async () => {
      const probe = await kit
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({ key: `pk_live_${'r'.repeat(24)}`, token: 'probe' });
      return probe.status !== 503;
    },
    'the limiter store to recover',
    30_000,
  );
  await clearRateLimits(kit.app);
}
