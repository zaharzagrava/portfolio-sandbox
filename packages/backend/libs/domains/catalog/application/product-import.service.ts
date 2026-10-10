import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { PRODUCT_LIMITS } from '@marketplace-sandbox/contracts';
import { ApiConfigService, PlatformSettings } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ShopQueryService } from '@app/domains/tenancy';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PRODUCT_REPOSITORY, type ProductRepository } from '../domain/ports';
import { diffProduct } from '../domain/product-changes';
import {
  ProductValidationError,
  ShopNotActiveError,
} from '../domain/product-errors';
import { isUuid } from '../domain/product-input';
import { parseExternalItem, type ExternalItem } from '../domain/stock-input';
import { snapshotEvent } from './events/product-events';
import { ProductCacheInvalidation } from './product-cache-invalidation.service';

export type ExternalSource = 'import' | 'shopify' | 'woocommerce' | 'offline';

export interface ExternalUpsertResult {
  externalSku: string;
  productId?: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'rejected';
  productVersion?: number;
  errors?: Array<{ field: string; code: string }>;
}

/**
 * Create or update products from an external system by `(shop, externalSku)` (R1 for catalog-sync). Per call: the
 * shop must be active (checked before any write), each item is validated on its own (a bad item is reported
 * `rejected`, it does not fail the call), the valid ones are applied in one transaction. An unchanged item writes
 * nothing and emits nothing; an archived product keeps its status; stock is touched only when the item carries it.
 * A concurrent twin of the same sku never reaches the caller as a unique violation: the row is locked, or the insert
 * that lost the race is retried as an update.
 */
@Injectable()
export class ProductImportService {
  private readonly currency: string;

  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly shops: ShopQueryService,
    private readonly invalidation: ProductCacheInvalidation,
    config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.currency = new PlatformSettings(config).currency;
  }

  async upsertFromExternal(
    shopId: string,
    items: unknown[],
    source: ExternalSource,
  ): Promise<ExternalUpsertResult[]> {
    void source;
    if (
      !isUuid(shopId) ||
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > PRODUCT_LIMITS.importItemsPerCall
    )
      throw new ProductValidationError(['items']);

    const shop = (await this.shops.getShopsByIds([shopId])).get(shopId);
    if (!shop || shop.status !== 'ACTIVE')
      throw new ShopNotActiveError(
        shop?.status === 'SUSPENDED' || shop?.status === 'DELETING'
          ? shop.status
          : 'DELETED',
      );

    const results: ExternalUpsertResult[] = new Array(items.length);
    const valid: Array<{ index: number; item: ExternalItem }> = [];
    items.forEach((raw, index) => {
      const parsed = parseExternalItem(raw);
      if (parsed.ok) valid.push({ index, item: parsed.value });
      else
        results[index] = {
          externalSku:
            typeof (raw as { externalSku?: unknown })?.externalSku === 'string'
              ? (raw as { externalSku: string }).externalSku
              : '',
          outcome: 'rejected',
          errors: parsed.fields.map((field) => ({ field, code: 'invalid' })),
        };
    });

    const now = this.clock.now();
    const touched: Array<{ productId: string; version: number }> = [];
    if (valid.length > 0) {
      await this.runner.run(async () => {
        const events: EventEnvelope[] = [];
        for (const { index, item } of valid) {
          const fields = {
            externalSku: item.externalSku,
            title: item.title,
            description: item.description ?? '',
            brand: item.brand,
            category: item.category,
            priceMinor: item.priceMinor,
            currency: this.currency,
            ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
            tags: item.tags ?? [],
          };
          results[index] = await this.upsertOne(
            shopId,
            shop.isSandbox,
            fields,
            now,
            events,
            touched,
          );
        }
        await this.outbox.append(events);
      });
      await this.invalidation.afterWrite(touched);
    }
    return results;
  }

  private async upsertOne(
    shopId: string,
    isSandbox: boolean,
    fields: Parameters<ProductRepository['insertExternal']>[3],
    now: Date,
    events: EventEnvelope[],
    touched: Array<{ productId: string; version: number }>,
  ): Promise<ExternalUpsertResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.products.lockByExternalSku(
        shopId,
        fields.externalSku,
      );
      if (existing) {
        const { changes, fields: changed } = diffProduct(existing, fields);
        if (changed.length === 0)
          return {
            externalSku: fields.externalSku,
            productId: existing.id,
            outcome: 'unchanged',
            productVersion: existing.version,
          };
        const updated = await this.products.update(
          shopId,
          existing.id,
          existing.version,
          changes,
          now,
          { anyStatus: true },
        );
        if (!updated) continue; // the row changed under us: look again
        events.push(snapshotEvent('updated', updated, changed));
        touched.push({ productId: updated.id, version: updated.version });
        return {
          externalSku: fields.externalSku,
          productId: updated.id,
          outcome: 'updated',
          productVersion: updated.version,
        };
      }
      const created = await this.products.insertExternal(
        shopId,
        uuidv7(),
        isSandbox,
        fields,
        now,
      );
      if (!created) continue; // a concurrent twin inserted it first: update that one
      events.push(snapshotEvent('created', created, []));
      touched.push({ productId: created.id, version: created.version });
      return {
        externalSku: fields.externalSku,
        productId: created.id,
        outcome: 'created',
        productVersion: created.version,
      };
    }
    throw new Error(`external upsert did not settle for ${fields.externalSku}`);
  }
}
