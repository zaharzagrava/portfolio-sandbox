/** Hash tag {productId}: the live key and its staging key share a slot, so RENAME works on Redis Cluster. */
export const boughtTogetherKey = (productId: string) =>
  `rec:bought:{${productId}}`;
export const boughtTogetherStagingKey = (productId: string) =>
  `rec:bought:{${productId}}:next`;
export const BOUGHT_TOGETHER_PATTERN = 'rec:bought:*';
export const BUILD_LOCK_KEY = 'rec:build:lock';
export const buildMarkerKey = (runId: string) => `rec:build:${runId}`;
/** Product id of a live list key, or `null` for a staging or foreign key. */
export const productIdOfKey = (key: string): string | null =>
  /^rec:bought:\{([^}]+)\}$/.exec(key)?.[1] ?? null;
export const NEIGHBOURS = 20;
