import { cartPageResponseSchema, cartSchema, type CartPageResponse } from '@marketplace-sandbox/contracts';
import { http, HttpResponse } from 'msw';
import { SHOP_A } from './handlers';

/**
 * A tiny stateful cart server for the W03 cart component tests (UC1, UC2): `GET /api/bff/cart`, `GET /api/cart` and
 * `PUT /api/cart/items/:productId` over one in-memory list, so a write is visible to the next read like the real API.
 * Bodies are parsed with the contract schemas when built. `hold()` makes the next writes wait (to look at the screen
 * before the answer); `failNext(respond)` makes the next write answer with `respond()`.
 */
const origin = 'http://localhost:3000';

export type FakeLine = {
  productId: string;
  quantity: number;
  title?: string;
  priceMinor?: number;
  currency?: string;
  imageUrl?: string | null;
  inStock?: boolean;
  /** `null` is a shop-less line ("Other items"); omitted means the default shop. */
  shop?: { id: string; name: string } | null;
  /** `null` is a product the catalogue no longer knows. */
  product?: null;
};

export type FakeCartOptions = { droppedLines?: number; errors?: CartPageResponse['errors'] };

export function fakeCartBackend(initial: FakeLine[], options: FakeCartOptions = {}) {
  const lines = initial.map((line) => ({ ...line }));
  const puts: { productId: string; quantity: number }[] = [];
  const reads = { page: 0, lines: 0 };
  const failures: Array<() => Response> = [];
  let gate: Promise<void> | null = null;

  const toLine = (line: FakeLine) => ({ productId: line.productId, quantity: line.quantity, addedAt: '2026-10-10T10:00:00.000Z' });
  const toPageLine = (line: FakeLine) => ({
    ...toLine(line),
    product:
      line.product === null
        ? null
        : {
            title: line.title ?? 'Headphones',
            priceMinor: line.priceMinor ?? 1999,
            currency: line.currency ?? 'EUR',
            imageUrl: line.imageUrl ?? null,
            inStock: line.inStock ?? true,
          },
    shop: line.shop === undefined ? { id: SHOP_A, name: 'Sound Shop' } : line.shop,
  });

  const handlers = [
    http.get(`${origin}/api/bff/cart`, () => {
      reads.page += 1;
      return HttpResponse.json(
        cartPageResponseSchema.parse({ lines: lines.map(toPageLine), droppedLines: options.droppedLines ?? 0, errors: options.errors ?? [] }),
      );
    }),
    http.get(`${origin}/api/cart`, () => {
      reads.lines += 1;
      return HttpResponse.json(cartSchema.parse({ lines: lines.map(toLine), droppedLines: 0 }));
    }),
    http.put(`${origin}/api/cart/items/:productId`, async ({ params, request }) => {
      const productId = String(params.productId);
      const { quantity } = (await request.json()) as { quantity: number };
      puts.push({ productId, quantity });
      if (gate) await gate;
      const fail = failures.shift();
      if (fail) return fail();
      const index = lines.findIndex((line) => line.productId === productId);
      if (quantity === 0) {
        if (index !== -1) lines.splice(index, 1);
      } else if (index === -1) {
        lines.push({ productId, quantity });
      } else {
        lines[index] = { ...lines[index], quantity };
      }
      return HttpResponse.json(cartSchema.parse({ lines: lines.map(toLine), droppedLines: 0 }));
    }),
  ];

  return {
    handlers,
    puts,
    reads,
    lines,
    /** Writes wait until the returned function is called. */
    hold(): () => void {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
    failNext(respond: () => Response): void {
      failures.push(respond);
    },
  };
}
