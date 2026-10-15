import type { ShopSummary, ShopSummaryPort } from '../domain/payout-ports';

/**
 * Tenancy's R1 answer for specs: scriptable per shop, with a call log (AS-12 counts calls and ids per call). A shop
 * nobody registered is unknown, exactly like an id missing from `getShopsByIds`.
 */
export class FakeShopSummary implements ShopSummaryPort {
  readonly calls: string[][] = [];
  private readonly shops = new Map<string, ShopSummary>();
  failWith: Error | null = null;

  set(shopId: string, summary: Partial<ShopSummary> = {}): void {
    this.shops.set(shopId, {
      status: 'ACTIVE',
      payoutsEnabled: true,
      ...summary,
    });
  }

  remove(shopId: string): void {
    this.shops.delete(shopId);
  }

  reset(): void {
    this.calls.length = 0;
    this.shops.clear();
    this.failWith = null;
  }

  getSummaries(shopIds: string[]): Promise<Map<string, ShopSummary>> {
    this.calls.push([...shopIds]);
    if (this.failWith) return Promise.reject(this.failWith);
    const out = new Map<string, ShopSummary>();
    for (const id of shopIds) {
      const found = this.shops.get(id);
      if (found) out.set(id, found);
    }
    return Promise.resolve(out);
  }
}
