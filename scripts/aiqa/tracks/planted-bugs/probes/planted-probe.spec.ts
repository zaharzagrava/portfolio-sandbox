/**
 * Probes for the planted-bug kit. They pass on clean master and each one fails when its bug is planted.
 * `plant.sh --probe` copies this file to packages/backend/libs/domains/catalog/planted-probe.spec.ts of the throwaway
 * worktree (never the main checkout), runs it, and removes it again. No services needed (fakes only).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProductCommandService } from './application/product-command.service';
import { toPublicView } from './domain/product-view';
import { OrderQueryService } from '../orders/application/order-query.service';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const record = (over: Record<string, unknown> = {}) => ({
  id: '0192a000-0000-7000-8000-000000000001',
  shopId: '0192a000-0000-7000-8000-0000000000aa',
  createdBy: 'u1',
  title: 'Mug',
  description: '',
  brand: 'Clay',
  category: 'kitchen',
  priceMinor: 2450,
  currency: 'USD',
  rating: 0,
  tags: [] as string[],
  quantity: 12,
  status: 'ACTIVE',
  isSandbox: false,
  externalSku: null,
  version: 3,
  viewCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function service(current: ReturnType<typeof record>, shopStatus = 'ACTIVE') {
  const calls: unknown[][] = [];
  const products = {
    findInShop: async () => current,
    update: async (...args: unknown[]) => {
      calls.push(args);
      return { ...current, version: current.version + 1 };
    },
  };
  const shops = { getShopsByIds: async () => new Map([[current.shopId, { status: shopStatus, isSandbox: false }]]) };
  const svc = new ProductCommandService(
    products as never,
    {} as never,
    { run: (fn: () => unknown) => fn() } as never,
    { append: async () => undefined } as never,
    shops as never,
    { afterWrite: async () => undefined } as never,
    { record: () => undefined } as never,
    { get: () => undefined } as never,
    { now: () => NOW } as never,
    {} as never,
  );
  return { svc, calls };
}

describe('planted-bug probes', () => {
  it('bug 1: a suspended shop cannot change its products', async () => {
    const cur = record();
    const { svc, calls } = service(cur, 'SUSPENDED');
    await expect(svc.update(cur.shopId, cur.id, { title: 'New title', expectedVersion: 3 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('bug 4: an edit with an old version is refused (409) and writes nothing', async () => {
    const cur = record({ version: 5 });
    const { svc, calls } = service(cur);
    await expect(svc.update(cur.shopId, cur.id, { title: 'New title', expectedVersion: 3 })).rejects.toMatchObject({ constructor: expect.any(Function) });
    expect(calls).toHaveLength(0);
  });

  it('bug 4 control: an edit with the current version is written with that version', async () => {
    const cur = record({ version: 5 });
    const { svc, calls } = service(cur);
    await svc.update(cur.shopId, cur.id, { title: 'New title', expectedVersion: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toBe(5);
  });

  it('bug 5: the public product view has exactly the public fields', () => {
    expect(Object.keys(toPublicView(record() as never)).sort()).toEqual(
      ['brand', 'category', 'currency', 'description', 'id', 'inStock', 'priceMinor', 'rating', 'shopId', 'tags', 'title', 'updatedAt', 'version', 'viewCount'].sort(),
    );
  });

  it('bug 3: the seller order list returns a full page and a cursor when there are more', async () => {
    const row = (n: number) => ({ id: `s${n}`, orderId: `o${n}`, status: 'PAID', subtotalMinor: 100, currency: 'USD', buyerId: 'b', createdAt: new Date(NOW.getTime() - n * 1000) });
    const shopOrders = { pageForShop: async (_s: string, _st: unknown, limit: number) => [1, 2, 3, 4].map(row).slice(0, limit), lines: async () => [] };
    const svc = new OrderQueryService({} as never, shopOrders as never, {} as never, { now: () => NOW } as never);
    const page = await svc.getOrdersForShop('shop', { limit: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
  });

  it('bug 2: restoring a product needs products.write, like archiving', () => {
    const src = readFileSync(join(__dirname, 'api/product.controller.ts'), 'utf8');
    const at = src.indexOf("@Post(':productId/restore')");
    expect(at).toBeGreaterThan(0);
    const decorators = src.slice(src.lastIndexOf('@ShopScoped', at), at);
    expect(decorators).toContain("@ShopScoped('products.write')");
  });
});
