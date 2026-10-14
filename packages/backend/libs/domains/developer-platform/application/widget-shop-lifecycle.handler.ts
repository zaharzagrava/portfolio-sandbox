import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { WidgetSiteRepository } from '../domain/widget-ports';
import { widgetMetrics } from './widget-metrics';
import { WidgetSiteCache } from './widget-site.cache';

/**
 * What the three tenancy events do to the sites (FR-028, FR-033, FR-034): a version-guarded update of the shop copy, and
 * the purge of a deleted shop's sites. The guard is in the statement (`shopVersion < incoming`), so a duplicate or an
 * older event changes nothing and the handler is idempotent without a ledger. Every change drops the cached record, so
 * the next request on every instance decides from the new copy.
 */
@Injectable()
export class WidgetShopLifecycleHandler {
  constructor(
    private readonly sites: WidgetSiteRepository,
    private readonly cache: WidgetSiteCache,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async shopUpdated(input: {
    shopId: string;
    name: string;
    shopVersion: number;
  }): Promise<void> {
    const keys = await this.sites.applyShopCopy(input.shopId, {
      shopVersion: input.shopVersion,
      name: input.name,
    });
    await this.cache.invalidate(keys);
    widgetMetrics.consumer().add(1, {
      type: 'shop_updated',
      result: keys.length ? 'applied' : 'ignored',
    });
  }

  async statusChanged(input: {
    shopId: string;
    to: string;
    shopVersion: number;
  }): Promise<void> {
    const keys = await this.sites.applyShopCopy(input.shopId, {
      shopVersion: input.shopVersion,
      status: input.to,
    });
    await this.cache.invalidate(keys);
    widgetMetrics.consumer().add(1, {
      type: 'shop_status_changed',
      result: keys.length ? 'applied' : 'ignored',
    });
  }

  async shopDeleted(shopId: string): Promise<void> {
    const removed = await this.sites.deleteByShop(shopId, this.clock.now());
    await this.cache.invalidate(removed.map((r) => r.publishableKey));
    widgetMetrics.consumer().add(1, {
      type: 'shop_deleted',
      result: removed.length ? 'applied' : 'ignored',
    });
  }
}
