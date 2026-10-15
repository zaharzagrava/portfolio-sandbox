export const SHOP_PURGE_REPOSITORY = Symbol('SHOP_PURGE_REPOSITORY');

/** Deletes everything this capability holds for one shop, in bounded statements (AS-75). Own tables only. */
export interface ShopPurgeRepository {
  /** Nulls the sealed credentials of every integration of the shop. Returns the rows changed. */
  eraseCredentials(shopId: string): Promise<number>;
  /**
   * One statement: deletes at most `limit` rows from the first table that still holds rows of the shop (children
   * before their integrations). `deleted: 0` means nothing is left.
   */
  deleteBatch(
    shopId: string,
    limit: number,
  ): Promise<{ table: string | null; deleted: number }>;
}
