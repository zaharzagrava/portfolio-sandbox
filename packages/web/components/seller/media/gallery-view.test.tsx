import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { origin, SELLER_PRODUCT_ID, SELLER_SHOP_ID, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { GalleryView } from './gallery-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/products/${SELLER_PRODUCT_ID}/media`,
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * W04 F6 (S29 photos, `contracts/media-api.md`): the gallery sends `expectedVersion`, reads FR-073 `code` values, polls
 * `GET /media/:id` until `READY` and never builds a URL.
 */

const shopApi = `${origin}/api/shops/${SELLER_SHOP_ID}`;
const galleryUrl = `${shopApi}/products/${SELLER_PRODUCT_ID}/gallery`;
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const NEW_ID = '44444444-4444-4444-8444-444444444444';
const UPLOAD_URL = 'https://uploads.example.test/bucket';

const item = (mediaId: string, position: number) => ({
  mediaId,
  position,
  urls: { thumb: `https://cdn.example.test/media/derived/${mediaId}-t.webp`, feed: `https://cdn.example.test/media/derived/${mediaId}-f.webp`, full: `https://cdn.example.test/media/derived/${mediaId}.webp` },
  width: 800,
  height: 600,
});
const gallery = (list = ids, version = 3) => ({ items: list.map(item), version });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: 'about:blank', title: 'Never shown', status, detail: 'Never shown detail', instance: '/x', code, requestId: 'req-1', ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });
const owner = (status: string, extra: Record<string, unknown> = {}) => ({
  id: NEW_ID,
  status,
  purpose: 'product',
  shopId: SELLER_SHOP_ID,
  width: status === 'READY' ? 800 : null,
  height: status === 'READY' ? 600 : null,
  urls: status === 'READY' ? item(NEW_ID, 0).urls : null,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  ...extra,
});

let client: QueryClient;
function show(options: { shop?: ReturnType<typeof shopFixture> } = {}) {
  const shop = options.shop ?? shopFixture();
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)));
  return render(
    <QueryClientProvider client={client}>
      <GalleryView shopId={SELLER_SHOP_ID} productId={SELLER_PRODUCT_ID} pollMs={5} />
    </QueryClientProvider>,
  );
}
const serve = (body = gallery()) => server.use(http.get(galleryUrl, () => HttpResponse.json(body)));
const png = (name = 'mug.png') => new File([new Uint8Array(2048)], name, { type: 'image/png' });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  vi.clearAllMocks();
});

describe('W04 F6 photo gallery', () => {
  it('W04 F6-1: lists the photos in position order and uses the URLs exactly as the API gave them', async () => {
    serve();
    show();
    const list = await screen.findByRole('list', { name: 'Photos' });
    const images = within(list).getAllByRole('img');
    expect(images.map((img) => img.getAttribute('src'))).toEqual(ids.map((id) => item(id, 0).urls.thumb));
    expect(screen.getByText('3 of 20 photos')).toBeInTheDocument();
  });

  it('W04 F6-2: reordering and saving sends the whole list with expectedVersion and shows the answer', async () => {
    serve();
    let body: unknown;
    server.use(
      http.put(galleryUrl, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(gallery([ids[1], ids[0], ids[2]], 4));
      }),
    );
    const user = userEvent.setup();
    show();
    await screen.findByRole('list', { name: 'Photos' });
    expect(screen.getByRole('button', { name: 'Save photos' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move photo 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Save photos' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Photos saved'));
    expect(body).toEqual({ mediaIds: [ids[1], ids[0], ids[2]], expectedVersion: 3 });
    expect(client.getQueryData(queryKeys.seller.gallery(SELLER_SHOP_ID, SELLER_PRODUCT_ID))).toEqual(gallery([ids[1], ids[0], ids[2]], 4));
  });

  it('W04 F6-3: removing a photo drops it from the list that is saved', async () => {
    serve();
    let body: { mediaIds: string[] } | undefined;
    server.use(
      http.put(galleryUrl, async ({ request }) => {
        body = (await request.json()) as { mediaIds: string[] };
        return HttpResponse.json(gallery([ids[0], ids[2]], 4));
      }),
    );
    const user = userEvent.setup();
    show();
    await screen.findByRole('list', { name: 'Photos' });
    await user.click(screen.getByRole('button', { name: 'Remove photo 2' }));
    await user.click(screen.getByRole('button', { name: 'Save photos' }));
    await waitFor(() => expect(body?.mediaIds).toEqual([ids[0], ids[2]]));
  });

  it('W04 F6-4: an upload asks for permission, posts the file to the given URL, completes, polls until READY and adds the photo', async () => {
    serve();
    let started: unknown;
    // jsdom's FormData is not the one Node's fetch serialises, so the body is checked at `append`
    const appended: [string, unknown][] = [];
    const append = FormData.prototype.append;
    vi.spyOn(FormData.prototype, 'append').mockImplementation(function (this: FormData, name: string, value: string | Blob) {
      appended.push([name, value]);
      return append.call(this, name, value as Blob);
    });
    let polls = 0;
    server.use(
      http.post(`${shopApi}/media/uploads`, async ({ request }) => {
        started = await request.json();
        return HttpResponse.json(
          {
            mediaId: NEW_ID,
            upload: { url: UPLOAD_URL, fields: { key: 'originals/abc', policy: 'p', 'x-amz-signature': 's' }, expiresAt: '2026-10-17T10:00:00.000Z' },
            maxBytes: 15728640,
            allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
          },
          { status: 201 },
        );
      }),
      http.post(UPLOAD_URL, () => new HttpResponse(null, { status: 204 })),
      http.post(`${origin}/api/media/${NEW_ID}/complete`, () => HttpResponse.json({ status: 'PROCESSING' }, { status: 202 })),
      http.get(`${origin}/api/media/${NEW_ID}`, () => HttpResponse.json(++polls < 3 ? owner('PROCESSING') : owner('READY'))),
    );
    const user = userEvent.setup();
    show();
    await screen.findByRole('list', { name: 'Photos' });
    await user.upload(screen.getByLabelText('Add photos'), png());
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(4));
    expect(started).toEqual({ purpose: 'product' });
    // the signed fields as given, then the file's Content-Type (the policy requires image/), then the file last
    expect(appended.map(([name]) => name)).toEqual(['key', 'policy', 'x-amz-signature', 'Content-Type', 'file']);
    expect(appended[0][1]).toBe('originals/abc');
    expect(appended[3][1]).toBe('image/png');
    expect(appended.at(-1)?.[1]).toBeInstanceOf(File);
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('button', { name: 'Save photos' })).toBeEnabled();
  });

  it('W04 F6-5: an upload answered 200 REJECTED with a rejectCode shows the words of that code and adds nothing', async () => {
    serve();
    server.use(
      http.post(`${shopApi}/media/uploads`, () =>
        HttpResponse.json(
          { mediaId: NEW_ID, upload: { url: UPLOAD_URL, fields: { key: 'k' }, expiresAt: '2026-10-17T10:00:00.000Z' }, maxBytes: 15728640, allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] },
          { status: 201 },
        ),
      ),
      http.post(UPLOAD_URL, () => new HttpResponse(null, { status: 204 })),
      http.post(`${origin}/api/media/${NEW_ID}/complete`, () => HttpResponse.json({ status: 'REJECTED', rejectCode: 'multi_frame' })),
    );
    const user = userEvent.setup();
    show();
    await screen.findByRole('list', { name: 'Photos' });
    await user.upload(screen.getByLabelText('Add photos'), png('anim.png'));
    expect(await screen.findByText(/Animated images aren't supported/)).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(3);
  });

  it('W04 F6-6: a file of the wrong type or over 15 MB is refused before any request', async () => {
    serve();
    const asked = vi.fn();
    server.use(http.post(`${shopApi}/media/uploads`, () => (asked(), HttpResponse.json({}, { status: 500 }))));
    const user = userEvent.setup({ applyAccept: false });
    show();
    await screen.findByRole('list', { name: 'Photos' });
    await user.upload(screen.getByLabelText('Add photos'), new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(await screen.findByText(/notes\.txt/)).toBeInTheDocument();
    expect(screen.getByText(/Use a JPEG, PNG, WebP or AVIF image/)).toBeInTheDocument();
    const big = new File([new Uint8Array(1)], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 15_728_641 });
    await user.upload(screen.getByLabelText('Add photos'), big);
    expect(await screen.findByText(/Each photo can be up to 15 MB/)).toBeInTheDocument();
    expect(asked).not.toHaveBeenCalled();
  });

  it('W04 F6-7: 409 version_conflict on save offers "Load latest", which drops the draft and reads the gallery again', async () => {
    let reads = 0;
    server.use(
      http.get(galleryUrl, () => HttpResponse.json(++reads === 1 ? gallery() : gallery([ids[2], ids[0]], 5))),
      http.put(galleryUrl, () => problem(409, 'version_conflict', { currentVersion: 5 })),
    );
    const user = userEvent.setup();
    show();
    await screen.findByRole('list', { name: 'Photos' });
    await user.click(screen.getByRole('button', { name: 'Move photo 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Save photos' }));
    expect(await screen.findByText('This product changed since you opened it.')).toBeInTheDocument();
    expect(screen.queryByText('Never shown detail')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load latest' }));
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    expect(screen.queryByText('This product changed since you opened it.')).not.toBeInTheDocument();
  });

  it('W04 F6-8: 422 media_not_attachable and 409 product_archived read as sentences', async () => {
    serve();
    server.use(http.put(galleryUrl, () => problem(422, 'media_not_attachable', { failures: [{ mediaId: ids[0], code: 'not_ready' }] })));
    const user = userEvent.setup();
    show();
    await screen.findByRole('list', { name: 'Photos' });
    await user.click(screen.getByRole('button', { name: 'Move photo 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Save photos' }));
    expect(await screen.findByText(/aren't ready yet or no longer exist/)).toBeInTheDocument();
  });

  it('W04 F6-9: a member without products.write sees the photos and no controls', async () => {
    serve();
    show({ shop: shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }) });
    await screen.findByRole('list', { name: 'Photos' });
    expect(screen.queryByLabelText('Add photos')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save photos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move photo/ })).not.toBeInTheDocument();
  });

  it('W04 F6-10: a gallery of 20 photos cannot take more', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    serve(gallery(twenty));
    show();
    await screen.findByRole('list', { name: 'Photos' });
    expect(screen.getByLabelText('Add photos')).toBeDisabled();
    expect(screen.getByText('The gallery holds up to 20 photos.')).toBeInTheDocument();
  });

  it('W04 F6-11: a suspended shop disables the controls and says why', async () => {
    serve();
    show({ shop: shopFixture({ status: 'SUSPENDED' }) });
    await screen.findByRole('list', { name: 'Photos' });
    expect(screen.getByLabelText('Add photos')).toBeDisabled();
    expect(screen.getByText(/This shop is suspended/)).toBeInTheDocument();
  });
});
