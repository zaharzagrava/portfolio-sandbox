import { Injectable } from '@nestjs/common';
import {
  ProductCommandService,
  ProductQueryService,
} from '@app/domains/catalog';
import { ApiError, resourceMissing } from '../domain/errors';
import { ShopDirectory } from '../domain/ports';
import {
  list,
  PublicList,
  PublicProduct,
  PublicStock,
  toPublicProduct,
  toPublicStock,
} from '../domain/public-views';
import type { ApiContext } from './api-context';
import { translateUpstream } from './upstream-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateProductInput {
  title: string;
  description?: string;
  price: { amount: number; currency: string };
  stock?: number;
  category: string;
  brand: string;
}

export type UpdateProductInput = Partial<CreateProductInput>;

/**
 * Products and stock for the public API (FR-035…FR-040), on the catalog capability's exported services only (R1):
 * no query on `Product` or `Shop`, no event written here. Every lookup carries the key's shop, so another shop's id is
 * indistinguishable from an unknown one.
 */
@Injectable()
export class PublicCatalogService {
  constructor(
    private readonly commands: ProductCommandService,
    private readonly queries: ProductQueryService,
    private readonly directory: ShopDirectory,
  ) {}

  async list(
    ctx: ApiContext,
    query: { limit?: number; cursor?: string },
    expand: string[],
  ): Promise<PublicList<PublicProduct>> {
    try {
      const page = await this.commands.listByShop(ctx.shopId, {
        ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      const items = page.items.map((p) => toPublicProduct(p, ctx.livemode));
      await this.expandShop(ctx, items, expand);
      return list(items, page.nextCursor);
    } catch (error) {
      return translateUpstream(error);
    }
  }

  async get(
    ctx: ApiContext,
    id: string,
    expand: string[],
  ): Promise<PublicProduct> {
    if (!UUID.test(id)) throw resourceMissing();
    try {
      const item = toPublicProduct(
        await this.commands.getForShop(ctx.shopId, id.toLowerCase()),
        ctx.livemode,
      );
      await this.expandShop(ctx, [item], expand);
      return item;
    } catch (error) {
      return translateUpstream(error);
    }
  }

  async create(
    ctx: ApiContext,
    input: CreateProductInput,
  ): Promise<PublicProduct> {
    try {
      const created = await this.commands.create(ctx.shopId, ctx.actorId, {
        title: input.title,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        brand: input.brand,
        category: input.category,
        priceMinor: input.price.amount,
        currency: input.price.currency,
        ...(input.stock !== undefined ? { quantity: input.stock } : {}),
      });
      return toPublicProduct(created, ctx.livemode);
    } catch (error) {
      return translateUpstream(error);
    }
  }

  async update(
    ctx: ApiContext,
    id: string,
    input: UpdateProductInput,
    expectedVersion: number,
  ): Promise<PublicProduct> {
    if (!UUID.test(id)) throw resourceMissing();
    try {
      const updated = await this.commands.update(
        ctx.shopId,
        id.toLowerCase(),
        {
          expectedVersion,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.price !== undefined
            ? { priceMinor: input.price.amount, currency: input.price.currency }
            : {}),
          ...(input.stock !== undefined ? { quantity: input.stock } : {}),
        },
        ctx.actorId,
      );
      return toPublicProduct(updated, ctx.livemode);
    } catch (error) {
      return translateUpstream(error);
    }
  }

  async stock(ctx: ApiContext, id: string): Promise<PublicStock> {
    if (!UUID.test(id)) throw resourceMissing();
    try {
      return toPublicStock(
        await this.commands.getForShop(ctx.shopId, id.toLowerCase()),
        ctx.livemode,
      );
    } catch (error) {
      return translateUpstream(error);
    }
  }

  /** The products of this shop among `ids`, one statement (the ownership check of bulk stock and batches). */
  async ownedIds(shopId: string, ids: string[]): Promise<Set<string>> {
    const valid = ids
      .filter((id) => UUID.test(id))
      .map((id) => id.toLowerCase());
    try {
      const found = await this.queries.getProductsByIds(valid, { shopId });
      return new Set(found.keys());
    } catch (error) {
      return translateUpstream(error);
    }
  }

  /** `expand=shop`: one batch lookup for the whole page (FR-037). */
  private async expandShop(
    ctx: ApiContext,
    items: PublicProduct[],
    expand: string[],
  ): Promise<void> {
    if (!expand.includes('shop') || items.length === 0) return;
    const shop = (await this.directory.getShops([ctx.shopId])).get(ctx.shopId);
    if (!shop)
      throw new ApiError('internal_error', 'The shop could not be read.');
    for (const item of items)
      item.shop = { id: shop.id, name: shop.name, slug: shop.slug };
  }
}
