import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import type { WebhookEventType } from '../domain/webhook-events';
import { EndpointRepository } from '../domain/webhook-ports';
import {
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from '../domain/webhook-settings';

export interface Subscriber {
  id: string;
  apiVersion: string;
}

interface CachedSubscription {
  id: string;
  events: string[];
  apiVersion: string;
}

const shopKey = (shopId: string) => `wh:shop:${shopId}`;

/**
 * The enabled endpoints of a shop and what they subscribe to, as the router reads them (S43 FR-028, AS-34). The shared
 * cache (S52) holds them for at most `subscriptionCacheTtlMs` (5 s) and every change of an endpoint invalidates the
 * shop's entry, so another instance sees it at once; there is no per-process layer (`l1: 'never'`). The delivery path
 * does not use this cache at all: it reads the endpoint's status from the store at every attempt (AS-50).
 */
@Injectable()
export class WebhookSubscriptions {
  constructor(
    private readonly endpoints: EndpointRepository,
    private readonly cache: CacheService,
    @Inject(WEBHOOK_SETTINGS) private readonly settings: WebhookSettings,
  ) {}

  async invalidate(shopId: string, _endpointId?: string): Promise<void> {
    await this.cache.invalidate([shopKey(shopId)]);
  }

  async subscribers(
    shopId: string,
    type: WebhookEventType,
  ): Promise<Subscriber[]> {
    const all =
      (await this.cache.getOrLoad<CachedSubscription[]>(
        shopKey(shopId),
        async () =>
          (await this.endpoints.listEnabledForShop(shopId)).map((e) => ({
            id: e.id,
            events: e.events,
            apiVersion: e.apiVersion,
          })),
        { ttlMs: this.settings.subscriptionCacheTtlMs, l1: 'never' },
      )) ?? [];
    return all
      .filter((e) => e.events.includes(type))
      .map((e) => ({ id: e.id, apiVersion: e.apiVersion }));
  }
}
