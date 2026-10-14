import type { ApiScope } from '../domain/api-key-format';

/** Who a public call acts as, taken only from the verified key (FR-014). */
export interface ApiContext {
  /** The shop every lookup is scoped to: the live shop, or the sandbox shop of a test key. */
  shopId: string;
  /** The live shop that owns the key. */
  liveShopId: string;
  livemode: boolean;
  /** The staff member who created the key: the actor of the writes made through it. */
  actorId: string;
  scopes: ApiScope[];
}
