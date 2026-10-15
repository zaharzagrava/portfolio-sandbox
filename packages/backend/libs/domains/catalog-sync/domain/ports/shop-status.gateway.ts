export const SHOP_STATUS_GATEWAY = Symbol('SHOP_STATUS_GATEWAY');

export interface ShopStatusView {
  /** `ACTIVE`, `SUSPENDED`, `DELETING`, `DELETED` ... as tenancy reports it. */
  status: string;
  isSandbox: boolean;
}

/** Tenancy facts via `ShopQueryService` only. */
export interface ShopStatusGateway {
  /** <= 500 ids, one call; unknown shops are absent from the map. */
  getStatuses(shopIds: string[]): Promise<Map<string, ShopStatusView>>;
}
