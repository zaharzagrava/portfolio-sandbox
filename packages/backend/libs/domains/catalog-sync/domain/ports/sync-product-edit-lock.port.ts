export const SYNC_PRODUCT_EDIT_LOCK = Symbol('SYNC_PRODUCT_EDIT_LOCK');

/**
 * Serialises the field decisions for one product across instances (FR-018). It is a lock held on a connection of its
 * own and is not a database transaction, so the catalog calls made under it never join one of this capability's.
 */
export interface ProductEditLock {
  /** `timeout` when the lock could not be taken within `waitMs` (the caller answers `retry` / `contention`). */
  withLock<T>(
    shopId: string,
    productId: string,
    waitMs: number,
    work: () => Promise<T>,
  ): Promise<{ kind: 'locked'; value: T } | { kind: 'timeout' }>;
}
