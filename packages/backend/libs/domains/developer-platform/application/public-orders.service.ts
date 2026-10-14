import { Injectable } from '@nestjs/common';
import { OrderQueryService, type ShopOrderStatus } from '@app/domains/orders';
import { resourceMissing } from '../domain/errors';
import {
  list,
  PublicList,
  PublicOrder,
  toPublicOrder,
} from '../domain/public-views';
import type { ApiContext } from './api-context';
import { translateUpstream } from './upstream-errors';

/**
 * Orders for the public API (FR-041): the key's shop's slice only, through the order capability's exported service
 * (R1). The sandbox has no orders. The slice DTO carries a buyer id for the seller dashboard; the mapping drops it.
 */
@Injectable()
export class PublicOrdersService {
  constructor(private readonly orders: OrderQueryService) {}

  async list(
    ctx: ApiContext,
    query: { limit?: number; cursor?: string; status?: ShopOrderStatus },
  ): Promise<PublicList<PublicOrder>> {
    if (!ctx.livemode) return list([], null);
    try {
      const page = await this.orders.getOrdersForShop(ctx.shopId, {
        status: query.status,
        limit: query.limit,
        cursor: query.cursor,
      });
      return list(
        page.items.map((o) => toPublicOrder(o, ctx.livemode)),
        page.nextCursor,
      );
    } catch (error) {
      return translateUpstream(error);
    }
  }

  async get(ctx: ApiContext, id: string): Promise<PublicOrder> {
    if (!ctx.livemode) throw resourceMissing();
    try {
      const slice = await this.orders.getShopOrder(ctx.shopId, id);
      if (!slice) throw resourceMissing();
      return toPublicOrder(slice, ctx.livemode);
    } catch (error) {
      return translateUpstream(error);
    }
  }
}
