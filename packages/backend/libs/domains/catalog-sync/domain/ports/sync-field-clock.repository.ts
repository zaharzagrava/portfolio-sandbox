import type { SyncField } from '@marketplace-sandbox/contracts';

export const SYNC_FIELD_CLOCK_REPOSITORY = Symbol(
  'SYNC_FIELD_CLOCK_REPOSITORY',
);

export type FieldClocks = Partial<Record<SyncField, string>>;

export interface SyncFieldClockRepository {
  read(shopId: string, productId: string): Promise<FieldClocks>;
  /** Conditional upsert: a stored clock only ever moves forward. */
  advance(
    shopId: string,
    productId: string,
    clocks: FieldClocks,
  ): Promise<void>;
  deleteProduct(shopId: string, productId: string): Promise<number>;
  deleteShop(shopId: string, limit: number): Promise<number>;
}
