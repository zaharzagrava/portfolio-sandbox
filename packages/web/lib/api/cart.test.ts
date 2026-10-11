import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cartBody, cartPageBody, PRODUCT_A, PRODUCT_B, problemResponse, SHOP_A } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';
import { queryKeys } from '../query-keys';
import { problemFromError } from './errors';
import { mergeGuestCart, setLine, useCartCount, useCartLines, useCartPage, useLastMerge, useSetCartLine } from './cart';

const origin = 'http://localhost:3000';
const stubCookies = (value: string) => vi.spyOn(document, 'cookie', 'get').mockReturnValue(value);

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

const line = (productId: string, quantity: number) => ({ productId, quantity, addedAt: '2026-10-10T10:00:00.000Z' });
const pageLine = (productId: string, quantity: number, price = 1999) => ({
  productId,
  quantity,
  addedAt: '2026-10-10T10:00:00.000Z',
  product: { title: `T-${productId.slice(0, 4)}`, priceMinor: price, currency: 'EUR', imageUrl: null, inStock: true },
  shop: { id: SHOP_A, name: 'Sound Shop' },
});

let seen: Request[];
beforeEach(() => {
  seen = [];
  stubCookies('__Host-bff-csrf=tok');
});
afterEach(() => vi.restoreAllMocks());

const record = (request: Request) => seen.push(request.clone());
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('cart reads (W03 UC5)', () => {
  it('W03 AS-13: useCartLines parses GET /api/cart with cartSchema, same-origin, no Authorization and no CSRF header', async () => {
    server.use(
      http.get(`${origin}/api/cart`, ({ request }) => {
        record(request);
        return HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 2)] }));
      }),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useCartLines(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.lines).toEqual([line(PRODUCT_A, 2)]);
    expect(new URL(seen[0].url).pathname).toBe('/api/cart');
    expect(seen[0].headers.get('authorization')).toBeNull();
    expect(seen[0].headers.get('x-csrf-token')).toBeNull();
  });

  it('W03 AS-13: a body that does not match cartSchema is an error, not data', async () => {
    server.use(http.get(`${origin}/api/cart`, () => HttpResponse.json({ lines: [{ productId: 'x', quantity: 99 }], droppedLines: 0 })));
    const { wrapper } = setup();
    const { result } = renderHook(() => useCartLines(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(problemFromError(result.current.error).code).toBe('invalid_response');
  });

  it('W03 AS-09: useCartPage parses GET /api/bff/cart with cartPageResponseSchema', async () => {
    server.use(
      http.get(`${origin}/api/bff/cart`, ({ request }) => {
        record(request);
        return HttpResponse.json(cartPageBody());
      }),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useCartPage(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.lines[0].product?.title).toBe('Headphones');
    expect(new URL(seen[0].url).pathname).toBe('/api/bff/cart');
  });

  it('W03 AS-09: a cart page with an unknown field is rejected (strict schema)', async () => {
    server.use(http.get(`${origin}/api/bff/cart`, () => HttpResponse.json({ ...cartPageBody(), extra: 1 })));
    const { wrapper } = setup();
    const { result } = renderHook(() => useCartPage(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('W03 AS-13: useCartCount is null while unknown, then the unit count of every line', async () => {
    server.use(http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 2), line(PRODUCT_B, 3)] }))));
    const { wrapper } = setup();
    const { result } = renderHook(() => useCartCount(), { wrapper });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(5));
  });

  it('W03 AS-13: useCartCount is 0 for an empty cart and null when the read fails', async () => {
    server.use(http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines: [] }))));
    const empty = setup();
    const first = renderHook(() => useCartCount(), { wrapper: empty.wrapper });
    await waitFor(() => expect(first.result.current).toBe(0));

    server.use(http.get(`${origin}/api/cart`, () => problemResponse(500, 'internal')));
    const failing = setup();
    const second = renderHook(() => useCartCount(), { wrapper: failing.wrapper });
    await waitFor(() => expect(failing.client.getQueryState(queryKeys.cart.lines())?.status).toBe('error'));
    expect(second.result.current).toBeNull();
  });

  it('W03 AS-13: the cart is read under the shared keys', async () => {
    server.use(http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody())), http.get(`${origin}/api/bff/cart`, () => HttpResponse.json(cartPageBody())));
    const { client, wrapper } = setup();
    renderHook(() => [useCartLines(), useCartPage()], { wrapper });
    await waitFor(() => expect(client.getQueryData(queryKeys.cart.lines())).toBeDefined());
    await waitFor(() => expect(client.getQueryData(queryKeys.cart.page())).toBeDefined());
  });
});

describe('setLine (W03 UC5)', () => {
  it('W03 AS-04: PUTs {quantity} to /api/cart/items/:productId with the CSRF header and parses cartSchema', async () => {
    server.use(
      http.put(`${origin}/api/cart/items/${PRODUCT_A}`, async ({ request }) => {
        record(request);
        return HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 4)] }));
      }),
    );
    const result = await setLine(PRODUCT_A, 4);
    expect(result.lines).toEqual([line(PRODUCT_A, 4)]);
    expect(await seen[0].json()).toEqual({ quantity: 4 });
    expect(seen[0].headers.get('x-csrf-token')).toBe('tok');
    expect(seen[0].headers.get('authorization')).toBeNull();
    expect(new URL(seen[0].url).pathname).toBe(`/api/cart/items/${PRODUCT_A}`);
  });

  it('W03 AS-04: a malformed answer rejects with invalid_response', async () => {
    server.use(http.put(`${origin}/api/cart/items/${PRODUCT_A}`, () => HttpResponse.json({ nope: true })));
    await expect(setLine(PRODUCT_A, 1)).rejects.toMatchObject({ response: { data: { code: 'invalid_response' } } });
  });
});

describe('useSetCartLine (W03 UC5: optimistic, serialised, re-read)', () => {
  function seed(client: QueryClient, quantity = 2) {
    client.setQueryData(queryKeys.cart.lines(), cartBody({ lines: [line(PRODUCT_A, quantity), line(PRODUCT_B, 1)] }));
    client.setQueryData(queryKeys.cart.page(), cartPageBody({ lines: [pageLine(PRODUCT_A, quantity), pageLine(PRODUCT_B, 1, 500)] }));
  }
  const quantityIn = (client: QueryClient, productId: string) =>
    client.getQueryData<ReturnType<typeof cartBody>>(queryKeys.cart.lines())?.lines.find((entry) => entry.productId === productId)?.quantity ?? 0;
  const pageQuantityIn = (client: QueryClient, productId: string) =>
    client.getQueryData<ReturnType<typeof cartPageBody>>(queryKeys.cart.page())?.lines.find((entry) => entry.productId === productId)?.quantity ?? 0;

  it('W03 AS-04: the displayed quantity changes before the answer, on the lines and on the page', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.put(`${origin}/api/cart/items/${PRODUCT_A}`, async () => {
        await gate;
        return HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 3), line(PRODUCT_B, 1)] }));
      }),
      http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 3), line(PRODUCT_B, 1)] }))),
      http.get(`${origin}/api/bff/cart`, () => HttpResponse.json(cartPageBody({ lines: [pageLine(PRODUCT_A, 3), pageLine(PRODUCT_B, 1, 500)] }))),
    );
    const { client, wrapper } = setup();
    seed(client);
    const { result } = renderHook(() => useSetCartLine(), { wrapper });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current(PRODUCT_A, 3);
    });
    expect(quantityIn(client, PRODUCT_A)).toBe(3);
    expect(pageQuantityIn(client, PRODUCT_A)).toBe(3);
    release();
    await act(async () => {
      await pending;
    });
  });

  it('W03 AS-04: writes for one product are sent one at a time, the last value wins, and the cart is re-read after the last', async () => {
    const puts: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let reads = 0;
    server.use(
      http.put(`${origin}/api/cart/items/${PRODUCT_A}`, async ({ request }) => {
        const { quantity } = (await request.json()) as { quantity: number };
        puts.push(quantity);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, quantity)] }));
      }),
      http.get(`${origin}/api/cart`, () => {
        reads += 1;
        return HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 5)] }));
      }),
      http.get(`${origin}/api/bff/cart`, () => HttpResponse.json(cartPageBody({ lines: [pageLine(PRODUCT_A, 5)] }))),
    );
    const { client, wrapper } = setup();
    seed(client);
    renderHook(() => [useCartLines(), useCartPage()], { wrapper });
    const { result } = renderHook(() => useSetCartLine(), { wrapper });
    await tick();
    const readsBefore = reads;
    await act(async () => {
      await Promise.all([result.current(PRODUCT_A, 3), result.current(PRODUCT_A, 4), result.current(PRODUCT_A, 5)]);
    });
    expect(puts).toEqual([3, 5]);
    expect(maxInFlight).toBe(1);
    await waitFor(() => expect(reads).toBeGreaterThan(readsBefore));
    expect(quantityIn(client, PRODUCT_A)).toBe(5);
  });

  it('W03 AS-05: setting 0 removes the line from the lines and the page at once', async () => {
    server.use(
      http.put(`${origin}/api/cart/items/${PRODUCT_A}`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_B, 1)] }))),
      http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_B, 1)] }))),
      http.get(`${origin}/api/bff/cart`, () => HttpResponse.json(cartPageBody({ lines: [pageLine(PRODUCT_B, 1, 500)] }))),
    );
    const { client, wrapper } = setup();
    seed(client);
    const { result } = renderHook(() => useSetCartLine(), { wrapper });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current(PRODUCT_A, 0);
    });
    expect(quantityIn(client, PRODUCT_A)).toBe(0);
    expect(client.getQueryData<ReturnType<typeof cartBody>>(queryKeys.cart.lines())?.lines.map((entry) => entry.productId)).toEqual([PRODUCT_B]);
    expect(client.getQueryData<ReturnType<typeof cartPageBody>>(queryKeys.cart.page())?.lines.map((entry) => entry.productId)).toEqual([PRODUCT_B]);
    await act(async () => {
      await pending;
    });
  });

  it('W03 AS-07: a refused write rejects with the problem and the displayed values are rolled back', async () => {
    server.use(
      http.put(`${origin}/api/cart/items/${PRODUCT_A}`, () => problemResponse(422, 'cart_line_limit')),
      http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 2), line(PRODUCT_B, 1)] }))),
      http.get(`${origin}/api/bff/cart`, () => HttpResponse.json(cartPageBody({ lines: [pageLine(PRODUCT_A, 2), pageLine(PRODUCT_B, 1, 500)] }))),
    );
    const { client, wrapper } = setup();
    seed(client);
    const { result } = renderHook(() => useSetCartLine(), { wrapper });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current(PRODUCT_A, 9);
      } catch (error) {
        caught = error;
      }
    });
    expect(problemFromError(caught)).toMatchObject({ status: 422, code: 'cart_line_limit' });
    expect(quantityIn(client, PRODUCT_A)).toBe(2);
    expect(pageQuantityIn(client, PRODUCT_A)).toBe(2);
  });

  it('W03 AS-07: when the network fails the re-read fails too, and the values still roll back to the last saved ones', async () => {
    server.use(
      http.put(`${origin}/api/cart/items/${PRODUCT_A}`, () => HttpResponse.error()),
      http.get(`${origin}/api/cart`, () => HttpResponse.error()),
      http.get(`${origin}/api/bff/cart`, () => HttpResponse.error()),
    );
    const { client, wrapper } = setup();
    seed(client);
    const { result } = renderHook(() => useSetCartLine(), { wrapper });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current(PRODUCT_A, 4);
      } catch (error) {
        caught = error;
      }
    });
    expect(problemFromError(caught).status).toBe(0);
    expect(quantityIn(client, PRODUCT_A)).toBe(2);
    expect(pageQuantityIn(client, PRODUCT_A)).toBe(2);
  });

  it('W03 AS-07: after a failed write and a later good one the value is the good one', async () => {
    let calls = 0;
    server.use(
      http.put(`${origin}/api/cart/items/${PRODUCT_A}`, async ({ request }) => {
        calls += 1;
        const { quantity } = (await request.json()) as { quantity: number };
        if (calls === 1) return problemResponse(429, 'rate_limited', { retryAfter: 3 });
        return HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, quantity), line(PRODUCT_B, 1)] }));
      }),
      http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 6), line(PRODUCT_B, 1)] }))),
      http.get(`${origin}/api/bff/cart`, () => HttpResponse.json(cartPageBody({ lines: [pageLine(PRODUCT_A, 6), pageLine(PRODUCT_B, 1, 500)] }))),
    );
    const { client, wrapper } = setup();
    seed(client);
    const { result } = renderHook(() => useSetCartLine(), { wrapper });
    await act(async () => {
      await result.current(PRODUCT_A, 5).catch(() => undefined);
    });
    expect(quantityIn(client, PRODUCT_A)).toBe(2);
    await act(async () => {
      await result.current(PRODUCT_A, 6);
    });
    expect(quantityIn(client, PRODUCT_A)).toBe(6);
  });

  it('W03 AS-02: adding a product the cart does not hold yet appears in the lines; the page is re-read to learn its details', async () => {
    let pageReads = 0;
    server.use(
      http.put(`${origin}/api/cart/items/${PRODUCT_B}`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 2), line(PRODUCT_B, 1)] }))),
      http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 2), line(PRODUCT_B, 1)] }))),
      http.get(`${origin}/api/bff/cart`, () => {
        pageReads += 1;
        return HttpResponse.json(cartPageBody({ lines: [pageLine(PRODUCT_A, 2), pageLine(PRODUCT_B, 1, 500)] }));
      }),
    );
    const { client, wrapper } = setup();
    client.setQueryData(queryKeys.cart.lines(), cartBody({ lines: [line(PRODUCT_A, 2)] }));
    client.setQueryData(queryKeys.cart.page(), cartPageBody({ lines: [pageLine(PRODUCT_A, 2)] }));
    renderHook(() => useCartPage(), { wrapper });
    const { result } = renderHook(() => useSetCartLine(), { wrapper });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current(PRODUCT_B, 1);
    });
    expect(quantityIn(client, PRODUCT_B)).toBe(1);
    await act(async () => {
      await pending;
    });
    await waitFor(() => expect(pageReads).toBeGreaterThan(0));
    await waitFor(() => expect(pageQuantityIn(client, PRODUCT_B)).toBe(1));
  });
});

describe('mergeGuestCart (W03 AS-11, AS-12)', () => {
  it('W03 AS-11: POSTs /api/cart/merge with the CSRF header, resolves {droppedLines} and records it under lastMerge', async () => {
    server.use(
      http.post(`${origin}/api/cart/merge`, ({ request }) => {
        record(request);
        return HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 3)], droppedLines: 2 }));
      }),
    );
    const { client } = setup();
    const result = await mergeGuestCart(client);
    expect(result).toEqual({ droppedLines: 2 });
    expect(client.getQueryData(queryKeys.cart.lastMerge())).toEqual({ droppedLines: 2 });
    expect(seen[0].headers.get('x-csrf-token')).toBe('tok');
    expect(new URL(seen[0].url).pathname).toBe('/api/cart/merge');
  });

  it('W03 AS-11: a successful merge invalidates the cart reads so they show the summed quantities', async () => {
    server.use(http.post(`${origin}/api/cart/merge`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 5)], droppedLines: 0 }))));
    const { client } = setup();
    client.setQueryData(queryKeys.cart.lines(), cartBody({ lines: [line(PRODUCT_A, 2)] }));
    client.setQueryData(queryKeys.cart.page(), cartPageBody());
    await mergeGuestCart(client);
    expect(client.getQueryState(queryKeys.cart.lines())?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.cart.page())?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.cart.lastMerge())?.isInvalidated).toBe(false);
  });

  it.each([
    ['500', () => problemResponse(500, 'internal')],
    ['429', () => problemResponse(429, 'rate_limited', { retryAfter: 10 })],
    ['network failure', () => HttpResponse.error()],
    ['malformed body', () => HttpResponse.json({ wrong: true })],
  ])('W03 AS-12: a %s resolves {droppedLines: 0} and never throws', async (_label, respond) => {
    server.use(http.post(`${origin}/api/cart/merge`, respond));
    const { client } = setup();
    await expect(mergeGuestCart(client)).resolves.toEqual({ droppedLines: 0 });
    expect(client.getQueryData(queryKeys.cart.lastMerge())).toEqual({ droppedLines: 0 });
  });

  it('W03 AS-12: after a failed merge the next cart read is not blocked', async () => {
    server.use(
      http.post(`${origin}/api/cart/merge`, () => problemResponse(500, 'internal')),
      http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 1)] }))),
    );
    const { client, wrapper } = setup();
    await mergeGuestCart(client);
    const { result } = renderHook(() => useCartLines(), { wrapper });
    await waitFor(() => expect(result.current.data?.lines).toHaveLength(1));
  });

  it('W03 AS-12: without a query client it still resolves the result and does not throw', async () => {
    server.use(http.post(`${origin}/api/cart/merge`, () => HttpResponse.json(cartBody({ droppedLines: 1 }))));
    await expect(mergeGuestCart()).resolves.toEqual({ droppedLines: 1 });
  });

  it('W03 AS-11: useLastMerge reads what mergeGuestCart recorded', async () => {
    server.use(http.post(`${origin}/api/cart/merge`, () => HttpResponse.json(cartBody({ droppedLines: 3 }))));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useLastMerge(), { wrapper });
    expect(result.current).toBeUndefined();
    await act(async () => {
      await mergeGuestCart(client);
    });
    await waitFor(() => expect(result.current).toEqual({ droppedLines: 3 }));
  });
});
