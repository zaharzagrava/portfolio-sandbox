import { shardName } from '@app/common/shard';

/** The live name every search reads and the products projectors write through. */
export const PRODUCTS_ALIAS = shardName('products');
