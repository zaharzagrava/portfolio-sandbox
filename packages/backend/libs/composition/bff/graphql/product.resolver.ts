import { Args, Context, ID, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { CoreClient, CoreProduct } from '../core-client';
import { Loaders } from './loaders';
import { ProductGql, ShopGql } from './types';

export interface GqlContext {
  loaders: Loaders;
  auth?: string;
}

const toGql = (p: CoreProduct): ProductGql => ({ id: p.id, title: p.title, price: p.price, stock: p.quantity, category: p.category, shopId: p.shopId });

@Resolver(() => ProductGql)
export class ProductResolver {
  constructor(private readonly core: CoreClient) {}

  @Query(() => ProductGql, { nullable: true })
  async product(@Args('id', { type: () => ID }) id: string, @Context() ctx: GqlContext) {
    const p = await ctx.loaders.product.load(id);
    return p ? toGql(p) : null;
  }

  /** `products(ids: [...])` - all fetched in ONE batch call, and their shops in ONE more. */
  @Query(() => [ProductGql], { nullable: 'items' })
  async products(@Args('ids', { type: () => [ID] }) ids: string[], @Context() ctx: GqlContext) {
    const products = await ctx.loaders.product.loadMany(ids.slice(0, 50));
    return products.map((p) => (p && !(p instanceof Error) ? toGql(p) : null));
  }

  @ResolveField(() => ShopGql, { nullable: true })
  shop(@Parent() product: ProductGql, @Context() ctx: GqlContext) {
    return product.shopId ? ctx.loaders.shop.load(product.shopId) : null;
  }

  @ResolveField(() => [ProductGql], { nullable: true })
  async recommendations(@Parent() product: ProductGql, @Context() ctx: GqlContext) {
    try {
      const recs = await this.core.get<{ productId: string }[]>(`/products/${product.id}/recommendations?limit=6`, { timeoutMs: 300 });
      const loaded = await ctx.loaders.product.loadMany(recs.map((r) => r.productId));
      return loaded.filter((p): p is CoreProduct => !!p && !(p instanceof Error)).map(toGql);
    } catch {
      return null; // optional section: degrade, don't fail the query
    }
  }
}
