import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, Clock } from '@app/common/core/clock';
import { SecretBox } from '@app/domains/identity';
import {
  WIDGET_LIMITS,
  type CreateWidgetSiteRequest,
  type UpdateWidgetSiteRequest,
  type WidgetSiteCreatedDto,
  type WidgetSiteDto,
} from '@marketplace-sandbox/contracts';
import { ApiError } from '../domain/errors';
import { normalizeOrigins } from '../domain/origin';
import {
  generateIdentitySecret,
  generatePublishableKey,
  previousSecretState,
} from '../domain/site-rules';
import { WidgetError } from '../domain/widget-errors';
import {
  HistoryItem,
  WidgetCatalog,
  WidgetShops,
  WidgetSiteRecord,
  WidgetSiteRepository,
} from '../domain/widget-ports';
import { widgetMetrics } from './widget-metrics';
import { WidgetSiteCache } from './widget-site.cache';

const MAX_KEY_ATTEMPTS = 5;

export const secretContext = (siteId: string): string =>
  `widget-site:${siteId}`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const invalidField = (field: string): ApiError =>
  new ApiError('validation_failed', 'The request is not valid.', {
    errors: [{ field, code: 'invalid' }],
  });

/** The opaque cursor of the site list: the position after the last item (createdAt, id). */
export function encodeSiteCursor(site: WidgetSiteRecord): string {
  return Buffer.from(
    JSON.stringify({ c: site.createdAt.toISOString(), i: site.id }),
  ).toString('base64url');
}

export function decodeSiteCursor(cursor: string): {
  createdAt: Date;
  id: string;
} {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { c?: unknown; i?: unknown };
    const createdAt = new Date(String(parsed.c));
    if (
      typeof parsed.i !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(parsed.i) ||
      Number.isNaN(createdAt.getTime())
    )
      throw new Error('bad cursor');
    return { createdAt, id: parsed.i };
  } catch {
    throw invalidField('cursor');
  }
}

export function pageLimit(limit: number | undefined): number {
  const value = limit ?? WIDGET_LIMITS.pageLimit.default;
  if (
    !Number.isInteger(value) ||
    value < WIDGET_LIMITS.pageLimit.min ||
    value > WIDGET_LIMITS.pageLimit.max
  )
    throw invalidField('limit');
  return value;
}

/**
 * Dashboard side of the sites (FR-001…FR-010, FR-027, FR-037): one application service, no SQL. The clock is injected;
 * the identity secret exists in plaintext only in the response of create and rotate and is sealed with the site id as
 * context before it is stored.
 */
@Injectable()
export class WidgetSitesService {
  constructor(
    private readonly sites: WidgetSiteRepository,
    private readonly cache: WidgetSiteCache,
    private readonly catalog: WidgetCatalog,
    private readonly shops: WidgetShops,
    private readonly box: SecretBox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  toDto(site: WidgetSiteRecord): WidgetSiteDto {
    const previousValid =
      site.hasPreviousSecret &&
      previousSecretState(site.previousSecretExpiresAt, this.clock.now()) ===
        'valid';
    return {
      id: site.id,
      shopId: site.shopId,
      name: site.name,
      publishableKey: site.publishableKey,
      allowedOrigins: site.allowedOrigins,
      featuredProductIds: site.featuredProductIds,
      theme: site.theme,
      killSwitch: site.killSwitch,
      hasPreviousSecret: previousValid,
      previousSecretExpiresAt: previousValid
        ? iso(site.previousSecretExpiresAt)
        : null,
      version: site.version,
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
    };
  }

  private origins(list: readonly string[]): string[] {
    const result = normalizeOrigins(list);
    if (!result.ok)
      throw new WidgetError('origin_invalid', 'An origin is not valid.', {
        extensions: {
          details: { origin: String(result.origin), reason: result.reason },
        },
      });
    return result.origins;
  }

  /** One batch through R1 with the shop filter; a foreign or unknown product is the same refusal (AS-08). */
  private async featured(
    shopId: string,
    ids: readonly string[] | undefined,
  ): Promise<string[]> {
    const unique = [...new Set((ids ?? []).map((i) => i.toLowerCase()))];
    if (unique.length === 0) return [];
    let found: Map<string, unknown>;
    try {
      found = await this.catalog.productsOfShop(shopId, unique);
    } catch {
      throw new WidgetError('service_unavailable');
    }
    const missing = unique.find((id) => !found.has(id));
    if (missing)
      throw new WidgetError(
        'featured_product_invalid',
        'A featured product does not belong to this shop.',
        { extensions: { details: { productId: missing } } },
      );
    return unique;
  }

  async create(
    shopId: string,
    actorId: string,
    input: CreateWidgetSiteRequest,
  ): Promise<WidgetSiteCreatedDto> {
    const allowedOrigins = this.origins(input.origins);
    const featuredProductIds = await this.featured(
      shopId,
      input.featuredProductIds,
    );
    // The shop copy is read once, before the transaction opens: no network call inside it (AS-46).
    let shop;
    try {
      shop = (await this.shops.getShops([shopId])).get(shopId);
    } catch {
      throw new WidgetError('service_unavailable');
    }
    if (!shop) throw new WidgetError('shop_not_found');

    const id = uuidv7();
    const identitySecret = generateIdentitySecret();
    const identitySecretSealed = this.box.seal(
      identitySecret,
      secretContext(id),
    );
    const now = this.clock.now();
    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
      const result = await this.sites.createWithLimit({
        site: {
          id,
          shopId,
          name: input.name ?? WIDGET_LIMITS.name.default,
          publishableKey: generatePublishableKey(),
          allowedOrigins,
          featuredProductIds,
          identitySecretSealed,
          shopName: shop.name,
          shopStatus: shop.status,
          shopVersion: shop.shopVersion,
        },
        limit: WIDGET_LIMITS.sitesPerShop,
        now,
        actorId,
      });
      if (result.outcome === 'key_taken') continue;
      if (result.outcome === 'limit_reached')
        throw new WidgetError(
          'site_limit_reached',
          `A shop can have at most ${WIDGET_LIMITS.sitesPerShop} widget sites.`,
        );
      // A lookup of this key a moment ago may have been remembered as unknown (AS-20).
      await this.cache.invalidate([result.site.publishableKey]);
      return { ...this.toDto(result.site), identitySecret };
    }
    throw new Error('Could not mint an unused widget key');
  }

  async list(
    shopId: string,
    query: { limit?: number; cursor?: string },
  ): Promise<{ items: WidgetSiteDto[]; nextCursor: string | null }> {
    const limit = pageLimit(query.limit);
    const after = query.cursor ? decodeSiteCursor(query.cursor) : undefined;
    const rows = await this.sites.list(shopId, { limit: limit + 1, after });
    const page = rows.slice(0, limit);
    return {
      items: page.map((s) => this.toDto(s)),
      nextCursor:
        rows.length > limit ? encodeSiteCursor(page[page.length - 1]) : null,
    };
  }

  async get(shopId: string, siteId: string): Promise<WidgetSiteDto> {
    return this.toDto(await this.require(shopId, siteId));
  }

  private async require(
    shopId: string,
    siteId: string,
  ): Promise<WidgetSiteRecord> {
    const site = await this.sites.findForShop(shopId, siteId);
    if (!site) throw new WidgetError('widget_site_not_found');
    return site;
  }

  async update(
    shopId: string,
    siteId: string,
    actorId: string,
    input: UpdateWidgetSiteRequest,
  ): Promise<WidgetSiteDto> {
    const allowedOrigins = input.allowedOrigins
      ? this.origins(input.allowedOrigins)
      : undefined;
    const featuredProductIds =
      input.featuredProductIds !== undefined
        ? await this.featured(shopId, input.featuredProductIds)
        : undefined;
    const result = await this.sites.update({
      shopId,
      siteId,
      expectedVersion: input.expectedVersion,
      patch: {
        name: input.name,
        allowedOrigins,
        featuredProductIds,
        theme: input.theme,
      },
      now: this.clock.now(),
      actorId,
    });
    if (result.outcome === 'not_found')
      throw new WidgetError('widget_site_not_found');
    if (result.outcome === 'conflict')
      throw new WidgetError(
        'site_version_conflict',
        'The site was changed by someone else; read it again.',
      );
    if (result.site.version !== input.expectedVersion)
      await this.cache.invalidate([result.site.publishableKey]);
    return this.toDto(result.site);
  }

  async rotateSecret(
    shopId: string,
    siteId: string,
    actorId: string,
    overlapHours: number = WIDGET_LIMITS.overlapHours.default,
  ): Promise<{
    identitySecret: string;
    previousSecretExpiresAt: string | null;
  }> {
    const identitySecret = generateIdentitySecret();
    const now = this.clock.now();
    const result = await this.sites.rotateSecret({
      shopId,
      siteId,
      newSealed: this.box.seal(identitySecret, secretContext(siteId)),
      overlapHours,
      now,
      actorId,
    });
    if (result.outcome === 'not_found')
      throw new WidgetError('widget_site_not_found');
    if (result.outcome === 'in_progress')
      throw new WidgetError(
        'rotation_in_progress',
        'The previous secret is still valid; expire it or wait.',
      );
    return {
      identitySecret,
      previousSecretExpiresAt:
        overlapHours > 0 ? iso(result.site.previousSecretExpiresAt) : null,
    };
  }

  async expirePreviousSecret(
    shopId: string,
    siteId: string,
    actorId: string,
  ): Promise<WidgetSiteDto> {
    const result = await this.sites.expirePreviousSecret({
      shopId,
      siteId,
      now: this.clock.now(),
      actorId,
    });
    if (result.outcome === 'not_found')
      throw new WidgetError('widget_site_not_found');
    if (result.outcome === 'not_in_progress')
      throw new WidgetError(
        'rotation_not_in_progress',
        'There is no previous secret.',
      );
    return this.toDto(result.site);
  }

  async setKillSwitch(
    shopId: string,
    siteId: string,
    actorId: string,
    on: boolean,
  ): Promise<WidgetSiteDto> {
    const result = await this.sites.setKillSwitch({
      shopId,
      siteId,
      on,
      now: this.clock.now(),
      actorId,
    });
    if (result.outcome === 'not_found')
      throw new WidgetError('widget_site_not_found');
    if (result.outcome === 'changed') {
      widgetMetrics.killSwitch().add(1, { state: on ? 'on' : 'off' });
      await this.cache.invalidate([result.site.publishableKey]);
    }
    return this.toDto(result.site);
  }

  async remove(shopId: string, siteId: string, actorId: string): Promise<void> {
    const result = await this.sites.delete({
      shopId,
      siteId,
      now: this.clock.now(),
      actorId,
    });
    if (result.outcome === 'not_found')
      throw new WidgetError('widget_site_not_found');
    await this.cache.invalidate([result.publishableKey]);
  }

  async history(
    shopId: string,
    siteId: string,
    query: { limit?: number; cursor?: string },
  ): Promise<{
    items: {
      id: string;
      change: HistoryItem['change'];
      from: string | null;
      to: string | null;
      actorId: string | null;
      at: string;
    }[];
    nextCursor: string | null;
  }> {
    const limit = pageLimit(query.limit);
    let beforeSeq: number | undefined;
    if (query.cursor) {
      beforeSeq = Number(
        Buffer.from(query.cursor, 'base64url').toString('utf8'),
      );
      if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)
        throw invalidField('cursor');
    }
    const rows = await this.sites.history(shopId, siteId, {
      limit: limit + 1,
      beforeSeq,
    });
    if (rows === null) throw new WidgetError('widget_site_not_found');
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        change: r.change,
        from: r.from,
        to: r.to,
        actorId: r.actorId,
        at: r.at.toISOString(),
      })),
      nextCursor:
        rows.length > limit
          ? Buffer.from(String(page[page.length - 1].seq)).toString('base64url')
          : null,
    };
  }
}
