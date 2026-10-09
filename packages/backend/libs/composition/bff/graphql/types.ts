import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('Shop')
export class ShopGql {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field() slug: string;
}

@ObjectType('Product')
export class ProductGql {
  @Field(() => ID) id: string;
  @Field() title: string;
  @Field(() => Float, { description: 'Minor units' }) price: number;
  @Field(() => Int) stock: number;
  @Field() category: string;
  /** Resolved lazily through the per-request ShopLoader (batched). */
  @Field(() => ShopGql, { nullable: true }) shop?: ShopGql | null;
  @Field(() => [ProductGql], {
    nullable: true,
    description: 'Bought together (partial: null if the recommender is slow)',
  })
  recommendations?: ProductGql[] | null;
  shopId?: string | null;
}
