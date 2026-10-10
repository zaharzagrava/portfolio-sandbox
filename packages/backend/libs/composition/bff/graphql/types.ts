import {
  Field,
  Float,
  ID,
  Int,
  ObjectType,
  Scalar,
  type CustomScalar,
} from '@nestjs/graphql';
import { GraphQLError, Kind, type ValueNode } from 'graphql';

const INTEGER = /^-?\d{1,18}$/;

/**
 * Money in minor units as a lossless integer (S48 FR-038): a decimal string on the wire, so no client rounds it
 * through a double. Accepts a decimal string or an integer on input.
 */
@Scalar('MinorUnits')
export class MinorUnitsScalar implements CustomScalar<string, string> {
  description = 'Money in minor units: a decimal integer string';

  serialize(value: unknown): string {
    if (
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      typeof value === 'bigint'
    )
      return String(value);
    if (typeof value === 'string' && INTEGER.test(value)) return value;
    throw new GraphQLError('MinorUnits must be an integer');
  }

  parseValue(value: unknown): string {
    return this.serialize(value);
  }

  parseLiteral(ast: ValueNode): string {
    if (ast.kind === Kind.INT || ast.kind === Kind.STRING)
      return this.serialize(ast.value);
    throw new GraphQLError('MinorUnits must be an integer');
  }
}

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
  @Field(() => MinorUnitsScalar, {
    description: 'Price in minor units of `currency`',
  })
  priceMinor: string;
  @Field() currency: string;
  @Field() inStock: boolean;
  @Field() category: string;
  @Field(() => Float) rating: number;
  /** Resolved lazily through the per-request shop loader (batched). */
  @Field(() => ShopGql, { nullable: true }) shop?: ShopGql | null;
  @Field(() => [ProductGql], {
    nullable: 'itemsAndList',
    description:
      'Bought together; null (with an error entry) when the recommender is slow or down',
  })
  recommendations?: (ProductGql | null)[] | null;
  /** Not exposed: the shop this product belongs to, for the shop loader. */
  shopId?: string;
}

@ObjectType('ChatUnreadItem')
export class ChatUnreadItemGql {
  @Field() channelId: string;
  @Field(() => Int) unread: number;
  @Field(() => Int) lastSeq: number;
}

@ObjectType('ChatUnreadPage')
export class ChatUnreadPageGql {
  @Field(() => [ChatUnreadItemGql]) items: ChatUnreadItemGql[];
  @Field(() => String, { nullable: true }) nextCursor: string | null;
}
