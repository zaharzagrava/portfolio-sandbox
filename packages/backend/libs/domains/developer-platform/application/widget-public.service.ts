import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { CacheService } from '@app/infrastructure/cache';
import type { WidgetConfigDto } from '@marketplace-sandbox/contracts';
import { buildEmbedCsp } from '../domain/frame-policy';
import { matchOrigin } from '../domain/origin';
import { isPublishableKey } from '../domain/site-rules';
import { isShopActive } from '../domain/shop-copy';
import {
  originNotAllowed,
  serviceUnavailable,
  siteNotFound,
  widgetDisabled,
} from '../domain/widget-errors';
import {
  WidgetCatalog,
  WidgetRandom,
  type WidgetSiteView,
} from '../domain/widget-ports';
import { widgetMetrics } from './widget-metrics';
import {
  CONFIG_FRESH_MS,
  CONFIG_STALE_MS,
  WidgetSiteCache,
} from './widget-site.cache';

export const DEFAULT_BUNDLE_URL = '/widget/v1/app.js';

export interface ShapedConfig {
  body: WidgetConfigDto;
  /** The last good response served because the product lookup failed (AS-21). */
  stale: boolean;
}

/**
 * The public routes' decisions (FR-011…FR-017, FR-024…FR-026). Order on every route: key shape → site → origin → switch
 * and shop status → everything else; each step is its own method so a controller can add the registered origin's CORS
 * headers between the origin check and the switch check (a refusal of a registered origin still answers its page).
 */
@Injectable()
export class WidgetPublicService {
  private readonly log = new Logger('Widget');

  constructor(
    private readonly cache: WidgetSiteCache,
    private readonly store: CacheService,
    private readonly catalog: WidgetCatalog,
    private readonly random: WidgetRandom,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** A malformed key is refused before any lookup and never becomes a cache key (AS-17). */
  async resolveSite(
    key: unknown,
    metric: 'config' | 'identify' | 'embed',
  ): Promise<WidgetSiteView> {
    if (!isPublishableKey(key)) {
      this.count(metric, 'unknown_key');
      throw siteNotFound();
    }
    let site: WidgetSiteView | null;
    try {
      site = await this.cache.get(key);
    } catch (error) {
      this.log.error(`site lookup failed: ${(error as Error).message}`);
      this.count(metric, 'unavailable');
      throw serviceUnavailable();
    }
    if (!site) {
      this.count(metric, 'unknown_key');
      throw siteNotFound();
    }
    return site;
  }

  /** Whole-origin equality with the registered list; a missing, `null`, repeated or unregistered `Origin` is refused. */
  assertOrigin(
    site: WidgetSiteView,
    origin: unknown,
    metric: 'config' | 'identify' | 'embed',
  ): string {
    if (
      typeof origin !== 'string' ||
      !matchOrigin(site.allowedOrigins, origin)
    ) {
      widgetMetrics.originRejected().add(1, {});
      this.count(metric, 'origin_rejected');
      throw originNotAllowed();
    }
    return origin;
  }

  assertEnabled(
    site: WidgetSiteView,
    metric: 'config' | 'identify' | 'embed',
  ): void {
    if (site.killSwitch || !isShopActive(site.shopStatus)) {
      this.count(metric, 'disabled');
      throw widgetDisabled();
    }
  }

  private count(metric: 'config' | 'identify' | 'embed', result: string): void {
    widgetMetrics[metric]().add(1, { result });
  }

  /**
   * The configuration (FR-014, FR-015): the shop's live, non-archived products in the configured order from one batch
   * lookup, the shop name from the site's copy. The shaped response is kept 60 s and the last good one 600 s for the case
   * the lookup fails; with none, 503. A failure is never stored as a success.
   */
  async shapedConfig(site: WidgetSiteView): Promise<ShapedConfig> {
    let lookupFailed = false;
    let body: WidgetConfigDto | null;
    try {
      body = await this.store.getOrLoad<WidgetConfigDto>(
        WidgetSiteCache.configKey(site.publishableKey),
        async () => {
          try {
            return await this.buildConfig(site);
          } catch (error) {
            lookupFailed = true;
            throw error;
          }
        },
        {
          ttlMs: CONFIG_FRESH_MS,
          staleIfErrorMs: CONFIG_STALE_MS,
          jitter: 0,
          l1: 'never',
        },
      );
    } catch (error) {
      this.log.error(`configuration unavailable: ${(error as Error).message}`);
      this.count('config', 'unavailable');
      throw serviceUnavailable();
    }
    if (!body) {
      this.count('config', 'unavailable');
      throw serviceUnavailable();
    }
    this.count('config', lookupFailed ? 'stale' : 'ok');
    return { body, stale: lookupFailed };
  }

  private async buildConfig(site: WidgetSiteView): Promise<WidgetConfigDto> {
    const found = site.featuredProductIds.length
      ? await this.catalog.productsOfShop(site.shopId, site.featuredProductIds)
      : new Map();
    const products = site.featuredProductIds.flatMap((id) => {
      const p = found.get(id);
      if (!p || p.status === 'ARCHIVED') return [];
      return [
        {
          id: p.id,
          title: p.title,
          price: { amountMinor: p.priceMinor, currency: p.currency },
          inStock: p.inStock,
        },
      ];
    });
    return {
      version: 'v1',
      shop: { name: site.shopName },
      theme: site.theme,
      products,
      checkoutUrl: this.checkoutUrl(),
    };
  }

  private checkoutUrl(): string {
    return (
      this.config.get('widget_checkout_url') ||
      `${this.config.get('front_host')}/embed/checkout`
    );
  }

  /** The embed document (FR-024…FR-026): one nonced script, the nonce fresh on every call. */
  embed(site: WidgetSiteView): { html: string; csp: string } {
    const nonce = this.random.nonce();
    const csp = buildEmbedCsp({ nonce, origins: site.allowedOrigins });
    const bundle =
      this.config.get('widget_app_bundle_url') || DEFAULT_BUNDLE_URL;
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title></head><body>` +
      `<div id="widget-root" data-site="${encodeURIComponent(site.publishableKey)}"></div>` +
      `<script nonce="${nonce}" src="${escapeAttribute(bundle)}"></script></body></html>`;
    widgetMetrics.embed().add(1, { result: 'ok' });
    return { html, csp };
  }
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
