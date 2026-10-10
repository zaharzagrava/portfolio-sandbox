import { UseFilters } from '@nestjs/common';
import type DataLoader from 'dataloader';
import {
  Args,
  Context,
  ID,
  Info,
  Int,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import type { GraphQLResolveInfo } from 'graphql';
import type { ProductBatchItem } from '@marketplace-sandbox/contracts';
import { tokenOf } from '../credentials/credentials';
import { chatUnread } from '../upstream/endpoints/chat';
import { recommendations as recommendationsCall } from '../upstream/endpoints/discovery';
import { UpstreamFailure } from '../upstream/upstream-error';
import {
  badUserInput,
  fieldError,
  GraphqlPassThroughFilter,
} from './graphql-errors';
import { budgetsFor } from './loaders';
import type { GqlContext } from './loaders';
import { ChunkFailure } from './loader-batching';
import { ChatUnreadPageGql, ProductGql, ShopGql } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toProduct = (item: ProductBatchItem): ProductGql => ({
  id: item.id,
  title: item.title,
  priceMinor: String(item.priceMinor),
  currency: item.currency,
  inStock: item.inStock,
  category: item.category,
  rating: item.rating,
  shopId: item.shopId,
});

/** The top-level key of the response path: the root field (or its alias) a nested field belongs to. */
const rootKey = (info: GraphQLResolveInfo): string => {
  let path = info.path;
  while (path.prev) path = path.prev;
  return String(path.key);
};

/**
 * Throws the field error for a failed batch. A failed chunk is one object shared by all of its ids, so it is reported
 * once per root path (FR-032: "once per path, not once per ID"); the rest of that root's fields are just `null`.
 */
function failOnce(
  failure: ChunkFailure,
  ctx: GqlContext,
  info: GraphQLResolveInfo,
): null {
  let id = failureIds.get(failure);
  if (id === undefined) failureIds.set(failure, (id = ++failureSeq));
  const key = `${rootKey(info)}#${id}`;
  if (ctx.reported.has(key)) return null;
  ctx.reported.add(key);
  throw fieldError(failure);
}
const failureIds = new WeakMap<ChunkFailure, number>();
let failureSeq = 0;

/** One load; a failed batch becomes this path's error (once), anything else is not ours to hide. */
async function loadGuarded<T>(
  loader: DataLoader<string, T>,
  key: string,
  ctx: GqlContext,
  info: GraphQLResolveInfo,
): Promise<T | null> {
  try {
    return await loader.load(key);
  } catch (error) {
    if (error instanceof ChunkFailure) return failOnce(error, ctx, info);
    throw error;
  }
}

@Resolver(() => ProductGql)
@UseFilters(GraphqlPassThroughFilter)
export class ProductResolver {
  @Query(() => ProductGql, { nullable: true })
  async product(
    @Args('id', { type: () => ID }) id: string,
    @Context() ctx: GqlContext,
    @Info() info: GraphQLResolveInfo,
  ): Promise<ProductGql | null> {
    if (!UUID.test(id)) throw badUserInput('Argument "id" must be a UUID');
    const loaded = await loadGuarded(ctx.loaders.product, id, ctx, info);
    return loaded ? toProduct(loaded) : null;
  }

  /** `products(ids: [...])`: all fetched in ONE batch call (per 100), and their shops in ONE more. */
  @Query(() => [ProductGql], { nullable: 'itemsAndList' })
  async products(
    @Args('ids', { type: () => [ID] }) ids: string[],
    @Context() ctx: GqlContext,
    @Info() info: GraphQLResolveInfo,
  ): Promise<(ProductGql | null)[] | null> {
    const max = ctx.settings.graphql.maxIds;
    if (ids.length > max)
      throw badUserInput(`Argument "ids" accepts at most ${max} items`);
    if (ids.some((id) => !UUID.test(id)))
      throw badUserInput('Argument "ids" must contain UUIDs');
    if (ids.length === 0) return [];
    const loaded = await ctx.loaders.product.loadMany(ids);
    const failed = loaded.find(
      (l): l is ChunkFailure => l instanceof ChunkFailure,
    );
    if (failed) return failOnce(failed, ctx, info);
    return loaded.map((l) =>
      l && !(l instanceof Error) ? toProduct(l) : null,
    );
  }

  @Query(() => ShopGql, { nullable: true })
  async shop(
    @Args('id', { type: () => ID }) id: string,
    @Context() ctx: GqlContext,
    @Info() info: GraphQLResolveInfo,
  ): Promise<ShopGql | null> {
    if (!UUID.test(id)) throw badUserInput('Argument "id" must be a UUID');
    return loadGuarded(ctx.loaders.shop, id, ctx, info);
  }

  /** An identity field: the caller's token goes to this one call, and to nothing public (AS-42). */
  @Query(() => ChatUnreadPageGql, { nullable: true })
  async chatUnread(
    @Context() ctx: GqlContext,
  ): Promise<ChatUnreadPageGql | null> {
    if (!tokenOf(ctx.credentials))
      throw fieldError(
        new UpstreamFailure('UPSTREAM_UNAVAILABLE', false, {
          status: 401,
          unauthorized: true,
        }),
      );
    try {
      return await ctx.call(chatUnread(), budgetsFor(ctx.settings).chat);
    } catch (error) {
      throw fieldError(error);
    }
  }

  @ResolveField('shop', () => ShopGql, { nullable: true })
  async productShop(
    @Parent() product: ProductGql,
    @Context() ctx: GqlContext,
    @Info() info: GraphQLResolveInfo,
  ): Promise<ShopGql | null> {
    if (!product.shopId) return null;
    return loadGuarded(ctx.loaders.shop, product.shopId, ctx, info);
  }

  @ResolveField('recommendations', () => [ProductGql], {
    nullable: 'itemsAndList',
  })
  async productRecommendations(
    @Parent() product: ProductGql,
    @Args('first', { type: () => Int, nullable: true, defaultValue: 8 })
    first: number,
    @Context() ctx: GqlContext,
    @Info() info: GraphQLResolveInfo,
  ): Promise<(ProductGql | null)[]> {
    const max = ctx.settings.graphql.maxIds;
    if (!Number.isInteger(first) || first < 1 || first > max)
      throw badUserInput(
        `Argument "first" must be an integer from 1 to ${max}`,
      );
    let envelope;
    try {
      envelope = await ctx.call(
        recommendationsCall(product.id, first),
        budgetsFor(ctx.settings).recommendations,
      );
    } catch (error) {
      throw fieldError(error);
    }
    // recommended products come from the S34 envelope and are hydrated through the same batching loader
    const loaded = await ctx.loaders.product.loadMany(
      envelope.items.map((i) => i.productId),
    );
    const failed = loaded.find(
      (l): l is ChunkFailure => l instanceof ChunkFailure,
    );
    if (failed) failOnce(failed, ctx, info);
    return loaded.map((l) =>
      l && !(l instanceof Error) ? toProduct(l) : null,
    );
  }
}
