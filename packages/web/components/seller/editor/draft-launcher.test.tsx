import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { draftSchema } from '@marketplace-sandbox/contracts';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { productMemberFixture } from '@/lib/test/seller-inventory-fixtures';
import { origin, SELLER_PRODUCT_ID, SELLER_SHOP_ID, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { DraftLauncher } from './draft-launcher';

vi.mock('./listing-editor', () => ({
  ListingEditor: ({ draft, currency }: { draft: { id: string; title: string }; currency?: string }) => (
    <p>
      Editor for {draft.id} {draft.title} {currency}
    </p>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

/** W04 F1 (S06): the draft page finds the product's open draft or starts one; the editor itself is tested in `listing-editor.test.tsx`. */

const drafts = `${origin}/api/shops/${SELLER_SHOP_ID}/drafts`;
const DRAFT_ID = 'd1a2b3c4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const draft = (overrides: Record<string, unknown> = {}) =>
  draftSchema.parse({ id: DRAFT_ID, shopId: SELLER_SHOP_ID, productId: SELLER_PRODUCT_ID, title: 'Clay mug', status: 'DRAFT', baseProductVersion: 3, createdBy: 'f3c4d5e6-a7b8-4c9d-8e1f-2a3b4c5d6e7f', createdAt: '2026-10-17T08:00:00.000Z', updatedAt: '2026-10-17T08:00:00.000Z', publishedAt: null, ...overrides });
const page = (items: unknown[]) => http.get(drafts, () => HttpResponse.json({ items, nextCursor: null }));
const product = http.get(`${origin}/api/shops/${SELLER_SHOP_ID}/products/${SELLER_PRODUCT_ID}`, () => HttpResponse.json(productMemberFixture()));
const problem = (status: number, code: string) =>
  HttpResponse.json({ type: 'about:blank', title: 'Never shown', status, detail: 'Never shown detail', instance: '/x', code, requestId: 'req-l-1' }, { status, headers: { 'content-type': 'application/problem+json' } });

let client: QueryClient;
function show(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)), product);
  return render(
    <QueryClientProvider client={client}>
      <DraftLauncher shopId={SELLER_SHOP_ID} productId={SELLER_PRODUCT_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  vi.clearAllMocks();
});

describe('W04 F1 draft launcher', () => {
  it('W04 F1-40: opens the open draft of this product, ignoring drafts of other products, asking for status=DRAFT', async () => {
    let params: URLSearchParams | undefined;
    server.use(
      http.get(drafts, ({ request }) => ((params = new URL(request.url).searchParams), HttpResponse.json({ items: [draft({ id: 'aaaaaaaa-0000-4000-8000-000000000001', productId: null, title: 'Other' }), draft()], nextCursor: null }))),
    );
    show();
    expect(await screen.findByText(`Editor for ${DRAFT_ID} Clay mug EUR`)).toBeInTheDocument();
    expect(params?.get('status')).toBe('DRAFT');
  });

  it('W04 F1-41: with no open draft it offers "Start a draft", which posts the product title and id and then opens the editor', async () => {
    let body: unknown;
    server.use(page([]), http.post(drafts, async ({ request }) => ((body = await request.json()), HttpResponse.json(draft({ title: 'Handmade Ceramic Mug' }), { status: 201 }))));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Start a draft' }));
    expect(await screen.findByText(`Editor for ${DRAFT_ID} Handmade Ceramic Mug EUR`)).toBeInTheDocument();
    expect(body).toEqual({ title: 'Handmade Ceramic Mug', productId: SELLER_PRODUCT_ID });
  });

  it.each([
    [409, 'product_archived', 'This product was archived or restored elsewhere. The list has been refreshed.'],
    [409, 'draft_limit_reached', 'You have the maximum number of open drafts. Archive one to start another.'],
    [404, 'product_not_found', 'This product no longer exists.'],
  ])('W04 F1-42: starting a draft refused with %i %s reads as a sentence', async (status, code, text) => {
    server.use(page([]), http.post(drafts, () => problem(status, code)));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Start a draft' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText('Never shown detail')).not.toBeInTheDocument();
  });

  it('W04 F1-43: a member without products.write sees an explanation instead of "Start a draft"', async () => {
    server.use(page([]));
    show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    expect(await screen.findByText('There is no open draft for this product, and your role cannot start one.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a draft' })).not.toBeInTheDocument();
  });

  it('W04 F1-44: a failed list shows the problem with Try again', async () => {
    let calls = 0;
    server.use(http.get(drafts, () => (calls++ === 0 ? problem(409, 'overloaded') : HttpResponse.json({ items: [draft()], nextCursor: null }))));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText(`Editor for ${DRAFT_ID} Clay mug EUR`)).toBeInTheDocument());
  });
});
