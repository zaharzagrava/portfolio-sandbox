/** Hash tag {productId}: the live key and its staging key share a slot, so RENAME works on Redis Cluster. */
export const boughtTogetherKey = (productId: string) => `rec:bought:{${productId}}`;
export const boughtTogetherStagingKey = (productId: string) => `rec:bought:{${productId}}:next`;
export const NEIGHBOURS = 20;
