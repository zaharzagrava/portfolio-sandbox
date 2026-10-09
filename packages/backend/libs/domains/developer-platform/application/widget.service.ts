import {
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { ApiConfigService } from '@app/common/config';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { SecretBox } from '@app/domains/identity';

export interface WidgetSite {
  id: string;
  shopId: string;
  publishableKey: string;
  allowedOrigins: string[];
  featuredProductIds: string[];
  theme: Record<string, string>;
  killSwitch: boolean;
  identitySecretSealed: string;
}

const siteKey = (pk: string) => `widget:site:${pk}`;
const ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/;
const HANDOFF_MAX_TTL_SEC = 300;
const WIDGET_TOKEN_TTL_SEC = 15 * 60;

/** Origins are compared exactly (scheme + host + port), never by suffix: `evil-shop.com` must not pass for `shop.com`. */
export function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    const normalized = `${url.protocol}//${url.host}`.toLowerCase();
    return ORIGIN.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

@Injectable()
export class WidgetService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly cache: CacheService,
    private readonly redis: RedisService,
    private readonly box: SecretBox,
    private readonly config: ApiConfigService,
  ) {}

  async createSite(
    shopId: string,
    origins: string[],
    featuredProductIds: string[] = [],
  ) {
    const allowed = origins.map(normalizeOrigin);
    if (allowed.some((o) => !o))
      throw new ForbiddenException('Origins must be https://host[:port]');
    const publishableKey = `pk_live_${randomBytes(18).toString('base64url')}`;
    const identitySecret = `wis_${randomBytes(32).toString('base64url')}`;
    const [site] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "WidgetSite" ("shopId", "publishableKey", "allowedOrigins", "identitySecretSealed", "featuredProductIds")
       VALUES (:shopId, :publishableKey, CAST(:origins AS text[]), :sealed, CAST(:featured AS uuid[])) RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          shopId,
          publishableKey,
          origins: `{${allowed.join(',')}}`,
          sealed: this.box.seal(identitySecret),
          featured: `{${featuredProductIds.join(',')}}`,
        },
      },
    );
    // The identity secret goes to the shop's BACKEND only (never into their page).
    return {
      id: site.id,
      publishableKey,
      identitySecret,
      allowedOrigins: allowed,
    };
  }

  async setKillSwitch(shopId: string, siteId: string, on: boolean) {
    const [site] = await this.sequelize.query<{ publishableKey: string }>(
      `UPDATE "WidgetSite" SET "killSwitch" = :on WHERE id = :siteId AND "shopId" = :shopId RETURNING "publishableKey"`,
      {
        type: QueryTypes.SELECT,
        replacements: { on, siteId, shopId },
      },
    );
    if (!site) throw new NotFoundException();
    await this.cache.invalidate([siteKey(site.publishableKey)]);
  }

  async site(publishableKey: string): Promise<WidgetSite> {
    const site = await this.cache.getOrLoad<WidgetSite>(
      siteKey(publishableKey),
      async () =>
        (
          await this.sequelize.query<WidgetSite>(
            `SELECT * FROM "WidgetSite" WHERE "publishableKey" = :publishableKey`,
            { type: QueryTypes.SELECT, replacements: { publishableKey } },
          )
        )[0] ?? null,
      { ttlMs: 60_000, negativeTtlMs: 60_000, l1: 'always', l1TtlMs: 10_000 },
    );
    if (!site) throw new NotFoundException('Unknown site key');
    return site;
  }

  /**
   * Every widget call carries the key AND comes from a browser that sets
   * `Origin` (the shop's page can't forge it). Unregistered origin → 403;
   * killed site → 410 (the loader then renders nothing).
   */
  async authorize(
    publishableKey: string,
    origin: string | undefined,
  ): Promise<WidgetSite> {
    const site = await this.site(publishableKey);
    const normalized = origin ? normalizeOrigin(origin) : null;
    if (!normalized || !site.allowedOrigins.includes(normalized))
      throw new ForbiddenException('Origin not registered for this site key');
    if (site.killSwitch) throw new GoneException('Widget disabled');
    return site;
  }

  async config_(site: WidgetSite) {
    const [shop] = await this.sequelize.query<{ name: string }>(
      `SELECT name FROM "Shop" WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: site.shopId } },
    );
    const products = site.featuredProductIds.length
      ? await this.sequelize.query<{
          id: string;
          title: string;
          price: string;
          quantity: number;
        }>(
          `SELECT id, title, price, quantity FROM "Product" WHERE id IN (:ids) AND "shopId" = :shopId`,
          {
            type: QueryTypes.SELECT,
            replacements: { ids: site.featuredProductIds, shopId: site.shopId },
          },
        )
      : [];
    return {
      shop: { name: shop?.name ?? '' },
      theme: site.theme,
      products: products.map((p) => ({
        id: p.id,
        title: p.title,
        price: Number(p.price),
        inStock: p.quantity > 0,
      })),
      checkoutUrl: `${this.config.get('front_host')}/embed/checkout`,
    };
  }

  /**
   * Identity hand-off (no third-party cookies): the shop's backend signs
   * `{sub: customerId, email, aud: "marketplace-widget", iss: <pk>, exp ≤ 5 min, jti}`
   * with its identity secret (HS256); the widget sends it here and gets OUR
   * short-lived widget token, kept in memory by the iframe.
   * Single use (jti), algorithm pinned, issuer must be this site key.
   * Deliberately NOT linked to a marketplace account by email - an attacker
   * controlling a shop could otherwise mint a token for any victim's email.
   */
  async identify(site: WidgetSite, handoff: string) {
    const secret = this.box.open(site.identitySecretSealed);
    let claims: jwt.JwtPayload;
    try {
      claims = jwt.verify(handoff, secret, {
        algorithms: ['HS256'],
        audience: 'marketplace-widget',
        issuer: site.publishableKey,
        maxAge: HANDOFF_MAX_TTL_SEC,
      }) as jwt.JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid identity token');
    }
    if (
      !claims.sub ||
      !claims.jti ||
      !claims.exp ||
      claims.exp - Math.floor(Date.now() / 1000) > HANDOFF_MAX_TTL_SEC
    )
      throw new UnauthorizedException(
        'Identity token must have sub, jti and exp ≤ 5 min',
      );
    if (
      !(await this.redis.client.set(
        `widget:jti:${site.id}:${claims.jti}`,
        '1',
        'EX',
        HANDOFF_MAX_TTL_SEC * 2,
        'NX',
      ))
    )
      throw new UnauthorizedException('Identity token already used');

    const token = jwt.sign(
      {
        typ: 'widget',
        site: site.id,
        shop: site.shopId,
        ext: claims.sub,
        email: claims.email,
      },
      this.config.get('jwt_secret'),
      { expiresIn: WIDGET_TOKEN_TTL_SEC, audience: 'widget' },
    );
    return {
      widgetToken: token,
      expiresIn: WIDGET_TOKEN_TTL_SEC,
      customer: { id: claims.sub, email: claims.email ?? null },
    };
  }

  /** CSP for the embed page: only this site's registered origins may frame it. */
  frameAncestors(site: WidgetSite): string {
    return `frame-ancestors ${site.allowedOrigins.join(' ')}`;
  }
}
