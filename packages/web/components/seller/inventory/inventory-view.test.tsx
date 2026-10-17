import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { readInventoryParams } from '@/lib/seller/search-params';
import { origin, SELLER_PRODUCT_ID, SELLER_SHOP_ID, sellerProblem, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { productMemberFixture } from '@/lib/test/seller-inventory-fixtures';
import { InventoryView } from './inventory-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const push = vi.fn();
const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/inventory`,
  useSearchParams: () => new URLSearchParams(search),
}));

const PATH = `/dashboard/seller/${SELLER_SHOP_ID}/inventory`;
const products = `${origin}/api/shops/${SELLER_SHOP_ID}/products`;
const CURRENCY = { code: 'EUR', fractionDigits: 2 };
const MUG = SELLER_PRODUCT_ID;
const row = (over: Record<string, unknown> = {}) => productMemberFixture(over);

let client: QueryClient;
function tree(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  // The shop comes seeded from the server render; a refetch (stale on mount) answers the same.
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)));
  return (
    <QueryClientProvider client={client}>
      <InventoryView shopId={SELLER_SHOP_ID} serverParams={readInventoryParams(Object.fromEntries(new URLSearchParams(search)))} currency={CURRENCY} />
    </QueryClientProvider>
  );
}
const show = (shop = shopFixture()) => render(tree(shop));

const list = (items: ReturnType<typeof row>[], nextCursor: string | null = null) => http.get(products, () => HttpResponse.json({ items, nextCursor }));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

const two = [row({ id: MUG, title: 'Handmade Ceramic Mug' }), row({ id: '4a2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b', title: 'Walnut Spoon', priceMinor: 1200, quantity: 3 })];

describe('W04 inventory list', () => {
  it('W04 AS-28: a table with the shop caption and columns lists the rows in the order returned, with a Next page link carrying the cursor', async () => {
    server.use(list(two, 'c2'));
    show();
    const table = await screen.findByRole('table', { name: 'Products of Clay Works' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(expect.arrayContaining(['Name', 'Price', 'Stock', 'Status']));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Handmade Ceramic Mug');
    expect(rows[0]).toHaveTextContent('€24.50');
    expect(rows[1]).toHaveTextContent('Walnut Spoon');
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', `${PATH}?cursor=c2`);
    expect(screen.queryByRole('link', { name: 'First page' })).not.toBeInTheDocument();
  });

  it('W04 AS-28: on a later page a First page link appears and the cursor is sent to the API', async () => {
    search = 'cursor=c2';
    let seen: URL | undefined;
    server.use(http.get(products, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json({ items: two, nextCursor: null }))));
    show();
    expect(await screen.findByRole('link', { name: 'First page' })).toHaveAttribute('href', PATH);
    expect(seen?.searchParams.get('cursor')).toBe('c2');
    expect(screen.queryByRole('link', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('W04 AS-29: the Archived tab and the stock filter write the URL without defaults and drop the cursor; the tabs move with the arrow keys', async () => {
    search = 'cursor=c2';
    server.use(list(two));
    const user = userEvent.setup();
    show();
    await screen.findByRole('table');
    const tabs = screen.getByRole('tablist', { name: 'Product status' });
    expect(within(tabs).getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
    await user.click(within(tabs).getByRole('tab', { name: 'Archived' }));
    expect(push).toHaveBeenLastCalledWith(`${PATH}?status=ARCHIVED`);
    await user.selectOptions(screen.getByLabelText('Stock'), 'Out of stock');
    expect(push).toHaveBeenLastCalledWith(`${PATH}?inStock=false`);
    within(tabs).getByRole('tab', { name: 'Active' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(within(tabs).getByRole('tab', { name: 'Archived' })).toHaveFocus();
    expect(push).toHaveBeenLastCalledWith(`${PATH}?status=ARCHIVED`);
  });

  it('W04 AS-30: typing waits 300 ms, then replaces the URL; the tabs and the stock filter are disabled with the search hints; clearing restores', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.use(list(two));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = show();
    await screen.findByRole('table');
    await user.type(screen.getByRole('searchbox', { name: 'Search your products' }), 'ceramc mug');
    expect(replace).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(300));
    expect(replace).toHaveBeenCalledTimes(1);
    const target = new URL(replace.mock.calls[0]![0] as string, origin);
    expect(target.pathname).toBe(PATH);
    expect(target.searchParams.get('q')).toBe('ceramc mug');

    search = 'q=ceramc+mug';
    server.use(
      http.get(`${products}/search`, () =>
        HttpResponse.json({ items: [{ id: MUG, title: 'Handmade Ceramic Mug', priceMinor: 2450, currency: 'EUR', quantity: 12, status: 'ARCHIVED', rank: 0.9 }], nextCursor: null }),
      ),
    );
    view.rerender(tree());
    expect(await screen.findByText('Handmade Ceramic Mug')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').every((tab) => tab.hasAttribute('disabled'))).toBe(true);
    expect(screen.getByLabelText('Stock')).toBeDisabled();
    expect(screen.getByText('Search covers all products.')).toBeInTheDocument();
    expect(screen.getByText('Search results can take a few seconds to include new products.')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('Archived')).toBeInTheDocument());

    await user.clear(screen.getByRole('searchbox', { name: 'Search your products' }));
    act(() => void vi.advanceTimersByTime(300));
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenLastCalledWith(PATH);
  });

  it('W04 AS-31: the first load shows skeleton rows, a new filter keeps the old rows dimmed with aria-busy and never flashes an empty state', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get(products, async ({ request }) => {
        if (new URL(request.url).searchParams.get('status') === 'ARCHIVED') {
          await gate;
          return HttpResponse.json({ items: [], nextCursor: null });
        }
        return HttpResponse.json({ items: two, nextCursor: null });
      }),
    );
    const view = show();
    expect(document.querySelector('[data-skeleton="inventory"]')).not.toBeNull();
    expect(screen.queryByText('No products yet.')).not.toBeInTheDocument();
    await screen.findByText('Walnut Spoon');
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false');

    search = 'status=ARCHIVED';
    view.rerender(tree());
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByText('Walnut Spoon')).toBeInTheDocument();
    expect(screen.queryByText('No archived products.')).not.toBeInTheDocument();
    release();
    expect(await screen.findByText('No archived products.')).toBeInTheDocument();
  });

  it('W04 AS-31: a failed list shows the problem alert with Try again instead of an empty table, and Try again loads it', async () => {
    let fail = true;
    server.use(http.get(products, () => (fail ? sellerProblem('upstream_unavailable') : HttpResponse.json({ items: two, nextCursor: null }))));
    const user = userEvent.setup();
    show();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load this right now. Try again in a moment.");
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('No products yet.')).not.toBeInTheDocument();
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Walnut Spoon')).toBeInTheDocument();
  });

  it('W04 AS-32: no products, no match and no archived products say three different things', async () => {
    server.use(list([]));
    const user = userEvent.setup();
    const view = show();
    expect(await screen.findByText('No products yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add product' }).length).toBeGreaterThan(0);

    search = 'q=zzz';
    server.use(http.get(`${products}/search`, () => HttpResponse.json({ items: [], nextCursor: null })));
    view.rerender(tree());
    expect(await screen.findByText('No products match “zzz”.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(replace).toHaveBeenLastCalledWith(PATH);

    search = 'status=ARCHIVED';
    view.rerender(tree());
    expect(await screen.findByText('No archived products.')).toBeInTheDocument();
  });

  it('W04 AS-32: a viewer with no products sees no Add product button', async () => {
    server.use(list([]));
    show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    expect(await screen.findByText('No products yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument();
  });

  it.each([
    [0, 'ACTIVE', 'Out of stock'],
    [3, 'ACTIVE', 'Low stock'],
    [5, 'ACTIVE', 'Low stock'],
    [6, 'ACTIVE', 'In stock'],
    [0, 'ARCHIVED', 'Archived'],
    [9, 'ARCHIVED', 'Archived'],
  ])('W04 AS-39: quantity %i, %s reads "%s" as a word in the cell', async (quantity, status, word) => {
    server.use(list([row({ quantity, status })]));
    show();
    const cells = await screen.findAllByRole('cell');
    expect(cells.some((cell) => cell.textContent?.includes(word))).toBe(true);
    expect(screen.getByRole('table')).toHaveTextContent(word);
  });

  it('W04 AS-43: a title with markup is shown as that exact text and nothing is created from it', async () => {
    const title = '<img src=x onerror=alert(1)>';
    server.use(list([row({ title })]));
    const { container } = show();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('W04 AS-95: the table has a caption, column headers with scope col and the name as the row header', async () => {
    server.use(list(two));
    show();
    const table = await screen.findByRole('table', { name: 'Products of Clay Works' });
    expect(table.querySelector('caption')).toHaveTextContent('Products of Clay Works');
    for (const header of within(table).getAllByRole('columnheader')) expect(header).toHaveAttribute('scope', 'col');
    expect(within(table).getByRole('rowheader', { name: 'Walnut Spoon' })).toHaveAttribute('scope', 'row');
  });
});

describe('W04 inventory actions', () => {
  it('W04 AS-42: a viewer reads: no action menu and no Add product; staff, admin and owner write', async () => {
    server.use(list(two));
    const view = show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    await screen.findByText('Walnut Spoon');
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument();
    view.unmount();
    client.clear();
    show(shopFixture({ myRole: 'STAFF' }));
    await screen.findByText('Walnut Spoon');
    expect(screen.getByRole('button', { name: 'Actions for Walnut Spoon' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add product' })).toBeEnabled();
  });

  it('W04 AS-86: in a suspended shop the write controls are disabled with the reason', async () => {
    server.use(list(two));
    show(shopFixture({ status: 'SUSPENDED' }));
    await screen.findByText('Walnut Spoon');
    expect(screen.getByRole('button', { name: 'Add product' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Actions for Walnut Spoon' }));
    expect(within(screen.getByRole('menu')).getByText('This shop is suspended. You can view data but not make changes.')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('W04 AS-94: the row menu opens with Enter, moves with arrow keys, and the archive confirmation starts on Cancel, closes with Escape and returns focus to the trigger', async () => {
    server.use(list(two));
    const user = userEvent.setup();
    show();
    await screen.findByText('Walnut Spoon');
    const trigger = screen.getByRole('button', { name: 'Actions for Handmade Ceramic Mug' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Edit', 'Adjust stock', 'Photos and video', 'Edit together', 'Archive']);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Archive product?' });
    expect(dialog).toHaveAccessibleDescription('It disappears from the storefront and search. You can restore it.');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('W04 AS-40: confirming the archive sends the version the row carried and says "Product archived"', async () => {
    let body: unknown;
    server.use(
      list(two),
      http.post(`${products}/${MUG}/archive`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(row({ status: 'ARCHIVED', version: 4 }));
      }),
    );
    const user = userEvent.setup();
    show();
    await screen.findByText('Walnut Spoon');
    await user.click(screen.getByRole('button', { name: 'Actions for Handmade Ceramic Mug' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await user.click(await screen.findByRole('button', { name: 'Archive product' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Product archived'));
    expect(body).toEqual({ expectedVersion: 3 });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('W04 AS-40: Restore on the Archived tab needs no confirmation and says "Product restored"', async () => {
    search = 'status=ARCHIVED';
    let body: unknown;
    server.use(
      list([row({ status: 'ARCHIVED' })]),
      http.post(`${products}/${MUG}/restore`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(row({ version: 4 }));
      }),
    );
    const user = userEvent.setup();
    show();
    await screen.findByText('Handmade Ceramic Mug');
    await user.click(screen.getByRole('button', { name: 'Actions for Handmade Ceramic Mug' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Product restored'));
    expect(body).toEqual({ expectedVersion: 3 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['product_archived', 'This product was archived or restored elsewhere. The list has been refreshed.'],
    ['invalid_transition', 'This product was archived or restored elsewhere. The list has been refreshed.'],
    ['product_not_found', 'This product no longer exists.'],
  ] as const)('W04 AS-41: a stale row answered %s is explained and the list refetches', async (code, text) => {
    let reads = 0;
    server.use(
      http.get(products, () => {
        reads += 1;
        return HttpResponse.json({ items: two, nextCursor: null });
      }),
      http.post(`${products}/${MUG}/archive`, () => sellerProblem(code)),
    );
    const user = userEvent.setup();
    show();
    await screen.findByText('Walnut Spoon');
    await user.click(screen.getByRole('button', { name: 'Actions for Handmade Ceramic Mug' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await user.click(await screen.findByRole('button', { name: 'Archive product' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('W04 AS-38: Adjust stock opens a popover, sends the whole number against the row version, and says "Stock updated"', async () => {
    let body: unknown;
    server.use(
      list(two),
      http.patch(`${products}/${MUG}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(row({ quantity: 20, version: 4 }));
      }),
    );
    const user = userEvent.setup();
    show();
    await screen.findByText('Walnut Spoon');
    await user.click(screen.getByRole('button', { name: 'Actions for Handmade Ceramic Mug' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Adjust stock' }));
    const field = await screen.findByLabelText('New stock');
    expect(field).toHaveValue('12');
    await user.clear(field);
    await user.type(field, '2.5');
    await user.click(screen.getByRole('button', { name: 'Update stock' }));
    expect(screen.getByText('Enter a whole number, 0 or more.')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '20');
    await user.click(screen.getByRole('button', { name: 'Update stock' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Stock updated'));
    expect(body).toEqual({ expectedVersion: 3, quantity: 20 });
    await waitFor(() => expect(screen.queryByLabelText('New stock')).not.toBeInTheDocument());
  });

  it('W04 AS-38: a sale during the edit answers 409 version_conflict: the popover names the new stock and keeps the number to confirm again', async () => {
    const bodies: unknown[] = [];
    server.use(
      list(two),
      http.patch(`${products}/${MUG}`, async ({ request }) => {
        bodies.push(await request.json());
        return bodies.length === 1 ? sellerProblem('version_conflict') : HttpResponse.json(row({ quantity: 20, version: 6 }));
      }),
      http.get(`${products}/${MUG}`, () => HttpResponse.json(row({ quantity: 4, version: 5 }))),
    );
    const user = userEvent.setup();
    show();
    await screen.findByText('Walnut Spoon');
    await user.click(screen.getByRole('button', { name: 'Actions for Handmade Ceramic Mug' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Adjust stock' }));
    const field = await screen.findByLabelText('New stock');
    await user.clear(field);
    await user.type(field, '20');
    await user.click(screen.getByRole('button', { name: 'Update stock' }));
    expect(await screen.findByText('Stock changed to 4 while you were editing.')).toBeInTheDocument();
    expect(screen.getByLabelText('New stock')).toHaveValue('20');
    await user.click(screen.getByRole('button', { name: 'Update stock' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Stock updated'));
    expect(bodies).toEqual([
      { expectedVersion: 3, quantity: 20 },
      { expectedVersion: 5, quantity: 20 },
    ]);
  });

  it('W04 AS-36: editing a search row loads the member view first, because search rows carry no version, and the dialog saves against that version', async () => {
    search = 'q=mug';
    let body: unknown;
    server.use(
      http.get(`${products}/search`, () =>
        HttpResponse.json({ items: [{ id: MUG, title: 'Handmade Ceramic Mug', priceMinor: 2450, currency: 'EUR', quantity: 12, status: 'ACTIVE', rank: 0.9 }], nextCursor: null }),
      ),
      http.get(`${products}/${MUG}`, () => HttpResponse.json(row({ version: 7 }))),
      http.patch(`${products}/${MUG}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(row({ version: 8, title: 'Mug v2' }));
      }),
    );
    const user = userEvent.setup();
    show();
    await screen.findByText('Handmade Ceramic Mug');
    await user.click(screen.getByRole('button', { name: 'Actions for Handmade Ceramic Mug' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit product' });
    const title = await within(dialog).findByLabelText('Title');
    expect(title).toHaveValue('Handmade Ceramic Mug');
    await user.clear(title);
    await user.type(title, 'Mug v2');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Product updated'));
    expect(body).toEqual({ expectedVersion: 7, title: 'Mug v2' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('W04 AS-33: Add product opens the create dialog; closing it returns focus to the button', async () => {
    server.use(list(two));
    const user = userEvent.setup();
    show();
    await screen.findByText('Walnut Spoon');
    const add = screen.getByRole('button', { name: 'Add product' });
    await user.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Add product' });
    await waitFor(() => expect(within(dialog).getByLabelText('Title')).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(add).toHaveFocus());
  });

  it('W04 AS-33: without a platform currency the create control is disabled and says why', async () => {
    server.use(list(two), http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shopFixture())));
    client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shopFixture());
    render(
      <QueryClientProvider client={client}>
        <InventoryView shopId={SELLER_SHOP_ID} serverParams={readInventoryParams({})} currency={undefined} />
      </QueryClientProvider>,
    );
    await screen.findByText('Walnut Spoon');
    expect(screen.getByRole('button', { name: 'Add product' })).toBeDisabled();
    expect(screen.getByText("Adding products isn't set up on this platform yet.")).toBeInTheDocument();
  });
});
