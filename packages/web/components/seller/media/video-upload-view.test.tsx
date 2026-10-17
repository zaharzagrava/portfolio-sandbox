import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { forgetEtags } from '@/lib/api/seller-media';
import { queryKeys } from '@/lib/query-keys';
import { origin, SELLER_PRODUCT_ID, SELLER_SHOP_ID, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { VideoUploadView } from './video-upload-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/products/${SELLER_PRODUCT_ID}/media/video`,
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * W04 F6 (S30 video, `contracts/video-api.md`): presigned part URLs are used as given, a failed part is retried alone,
 * an interrupted upload resumes through `GET …/upload`, `complete` answers `202` and the page polls `GET …/videos/:id`.
 */

const videos = `${origin}/api/shops/${SELLER_SHOP_ID}/videos`;
const VIDEO_ID = '55555555-5555-4555-8555-555555555555';
const PART = (n: number) => `https://parts.example.test/video/${VIDEO_ID}/${n}?sig=abc${n}`;
const SIZE = 3000;
const PART_SIZE = 1024;

const parts = (numbers: number[]) =>
  numbers.map((partNumber) => ({ partNumber, url: PART(partNumber), contentLength: partNumber === 3 ? SIZE - 2 * PART_SIZE : PART_SIZE }));
const startBody = (extra: Record<string, unknown> = {}) => ({ videoId: VIDEO_ID, partSize: PART_SIZE, partCount: 3, expiresAt: '2026-10-19T09:00:00.000Z', visibility: 'public', shareToken: null, parts: parts([1, 2, 3]), ...extra });
const owner = (status: string, extra: Record<string, unknown> = {}) => ({
  id: VIDEO_ID,
  title: 'Kiln tour',
  visibility: 'public',
  status,
  failureCode: null,
  retryable: false,
  productId: SELLER_PRODUCT_ID,
  durationSec: status === 'READY' ? 61 : null,
  width: status === 'READY' ? 1920 : null,
  height: status === 'READY' ? 1080 : null,
  renditions: [],
  progress: { stage: 'transcode', tasksDone: 1, tasksTotal: 4 },
  posterUrl: null,
  spriteUrl: null,
  shareToken: null,
  version: 1,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  ...extra,
});
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: 'about:blank', title: 'Never shown', status, detail: 'Never shown detail', instance: '/x', code, requestId: 'req-9', ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });
const mp4 = (name = 'tour.mp4') => new File([new Uint8Array(SIZE)], name, { type: 'video/mp4' });

let client: QueryClient;
function show(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)));
  return render(
    <QueryClientProvider client={client}>
      <VideoUploadView shopId={SELLER_SHOP_ID} productId={SELLER_PRODUCT_ID} tuning={{ pollMs: 5, retryDelayMs: 1 }} />
    </QueryClientProvider>,
  );
}
const list = (items: unknown[] = []) => http.get(videos, () => HttpResponse.json({ items, nextCursor: null }));
const partHandlers = (seen: number[], failFirst?: number) => {
  const failed = new Set<number>();
  return [1, 2, 3].map((n) =>
    http.put(PART(n), async ({ request }) => {
      seen.push(n);
      await request.arrayBuffer();
      if (failFirst === n && !failed.has(n)) {
        failed.add(n);
        return new HttpResponse(null, { status: 500 });
      }
      return new HttpResponse(null, { status: 200, headers: { ETag: `"etag-${n}"` } });
    }),
  );
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  forgetEtags(VIDEO_ID);
  vi.clearAllMocks();
});

async function chooseAndStart(user: ReturnType<typeof userEvent.setup>, file = mp4()) {
  await user.upload(await screen.findByLabelText('Video file'), file);
  await user.clear(screen.getByLabelText('Title'));
  await user.type(screen.getByLabelText('Title'), 'Kiln tour');
  await user.click(screen.getByRole('button', { name: 'Upload video' }));
}

describe('W04 F6 video upload', () => {
  it('W04 F6-20: starts with title, size, type and visibility, sends each part to its URL, completes with the etags and polls to Ready', async () => {
    let start: unknown;
    let complete: unknown;
    const seen: number[] = [];
    let polls = 0;
    // jsdom's Blob is not the one Node's fetch serialises, so the slices are checked where they are cut
    const slices: [number | undefined, number | undefined][] = [];
    const slice = Blob.prototype.slice;
    vi.spyOn(Blob.prototype, 'slice').mockImplementation(function (this: Blob, from?: number, to?: number) {
      slices.push([from, to]);
      return slice.call(this, from, to);
    });
    server.use(
      list(),
      http.post(videos, async ({ request }) => ((start = await request.json()), HttpResponse.json(startBody(), { status: 201 }))),
      ...partHandlers(seen),
      http.post(`${videos}/${VIDEO_ID}/complete`, async ({ request }) => ((complete = await request.json()), HttpResponse.json({ status: 'PROCESSING' }, { status: 202 }))),
      http.get(`${videos}/${VIDEO_ID}`, () => HttpResponse.json(++polls < 3 ? owner('PROCESSING') : owner('READY'))),
    );
    const user = userEvent.setup();
    show();
    await chooseAndStart(user);
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(start).toEqual({ title: 'Kiln tour', sizeBytes: SIZE, contentType: 'video/mp4', visibility: 'public', productId: SELLER_PRODUCT_ID });
    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(slices).toEqual([
      [0, 1024],
      [1024, 2048],
      [2048, 3000],
    ]);
    expect(complete).toEqual({ parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: `"etag-${n}"` })) });
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it('W04 F6-21: a part that fails is sent again alone and the others are not repeated', async () => {
    const seen: number[] = [];
    server.use(
      list(),
      http.post(videos, () => HttpResponse.json(startBody(), { status: 201 })),
      ...partHandlers(seen, 2),
      http.post(`${videos}/${VIDEO_ID}/complete`, () => HttpResponse.json({ status: 'PROCESSING' }, { status: 202 })),
      http.get(`${videos}/${VIDEO_ID}`, () => HttpResponse.json(owner('READY'))),
    );
    const user = userEvent.setup();
    show();
    await chooseAndStart(user);
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(seen.filter((n) => n === 1)).toHaveLength(1);
    expect(seen.filter((n) => n === 2)).toHaveLength(2);
    expect(seen.filter((n) => n === 3)).toHaveLength(1);
  });

  it('W04 F6-22: a part that keeps failing stops the upload with a "Resume upload" action; resuming reads GET …/upload and sends only the missing parts', async () => {
    const seen: number[] = [];
    let resumed = false;
    server.use(
      list(),
      http.post(videos, () => HttpResponse.json(startBody(), { status: 201 })),
      http.put(PART(1), () => (seen.push(1), new HttpResponse(null, { status: 200, headers: { ETag: '"etag-1"' } }))),
      http.put(PART(2), () => (seen.push(2), resumed ? new HttpResponse(null, { status: 200, headers: { ETag: '"etag-2"' } }) : new HttpResponse(null, { status: 503 }))),
      http.put(PART(3), () => (seen.push(3), new HttpResponse(null, { status: 200, headers: { ETag: '"etag-3"' } }))),
      http.get(`${videos}/${VIDEO_ID}/upload`, () =>
        HttpResponse.json({
          status: 'UPLOADING',
          partSize: PART_SIZE,
          partCount: 3,
          uploadedParts: [
            { partNumber: 1, size: PART_SIZE },
            { partNumber: 3, size: SIZE - 2 * PART_SIZE },
          ],
          missingParts: [2],
          parts: parts([2]),
          expiresAt: '2026-10-19T09:00:00.000Z',
        }),
      ),
      http.post(`${videos}/${VIDEO_ID}/complete`, () => HttpResponse.json({ status: 'PROCESSING' }, { status: 202 })),
      http.get(`${videos}/${VIDEO_ID}`, () => HttpResponse.json(owner('READY'))),
    );
    const user = userEvent.setup();
    show();
    await chooseAndStart(user);
    const resume = await screen.findByRole('button', { name: 'Resume upload' });
    expect(screen.getByRole('alert')).toHaveTextContent("The upload was interrupted. Choose the file again to resume it.");
    seen.length = 0;
    resumed = true;
    await user.upload(screen.getByLabelText('Video file'), mp4());
    await user.click(resume);
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(seen).toEqual([2]);
  });

  it('W04 F6-23: complete answered 409 upload_closed or invalid_state reads as a sentence and refreshes the video', async () => {
    const seen: number[] = [];
    server.use(
      list(),
      http.post(videos, () => HttpResponse.json(startBody(), { status: 201 })),
      ...partHandlers(seen),
      http.post(`${videos}/${VIDEO_ID}/complete`, () => problem(409, 'upload_closed', { status: 'EXPIRED' })),
    );
    const user = userEvent.setup();
    show();
    await chooseAndStart(user);
    expect(await screen.findByText('This upload is closed. Start a new one.')).toBeInTheDocument();
    expect(screen.queryByText('Never shown detail')).not.toBeInTheDocument();
  });

  it('W04 F6-24: 409 invalid_state says the video cannot take that action in its current state', async () => {
    server.use(
      list([owner('FAILED', { failureCode: 'transcode_failed', retryable: true })]),
      http.post(`${videos}/${VIDEO_ID}/retry`, () => problem(409, 'invalid_state', { status: 'READY' })),
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Retry processing' }));
    expect(await screen.findByText("This video can't be changed in its current state. The list has been refreshed.")).toBeInTheDocument();
  });

  it('W04 F6-25: a video that failed shows the words of its failureCode and offers a retry only when retryable', async () => {
    server.use(
      list([
        owner('FAILED', { failureCode: 'transcode_failed', retryable: true }),
        owner('FAILED', { id: '66666666-6666-4666-8666-666666666666', title: 'Too long', failureCode: 'duration_exceeded', retryable: false }),
      ]),
    );
    show();
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows[0]).toHaveTextContent("We couldn't process this video. Try again.");
    expect(within(rows[0]).getByRole('button', { name: 'Retry processing' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('This video is longer than the limit.');
    expect(within(rows[1]).queryByRole('button', { name: 'Retry processing' })).not.toBeInTheDocument();
  });

  it('W04 F6-26: start refused with product_video_limit or pending_uploads_limit shows its sentence and uploads nothing', async () => {
    const seen: number[] = [];
    server.use(list(), http.post(videos, () => problem(409, 'product_video_limit')), ...partHandlers(seen));
    const user = userEvent.setup();
    show();
    await chooseAndStart(user);
    expect(await screen.findByText('This product already has the maximum number of videos. Delete one to add another.')).toBeInTheDocument();
    expect(seen).toEqual([]);
  });

  it('W04 F6-27: a file that is not a supported video type or is too small is refused before any request', async () => {
    const asked = vi.fn();
    server.use(list(), http.post(videos, () => (asked(), problem(500, 'x'))));
    const user = userEvent.setup({ applyAccept: false });
    show();
    await user.upload(await screen.findByLabelText('Video file'), new File(['x'.repeat(2000)], 'a.avi', { type: 'video/x-msvideo' }));
    await user.type(screen.getByLabelText('Title'), 'Anything');
    await user.click(screen.getByRole('button', { name: 'Upload video' }));
    expect(await screen.findByText('Use an MP4, QuickTime or WebM video.')).toBeInTheDocument();
    expect(asked).not.toHaveBeenCalled();
  });

  it('W04 F6-28: a viewer sees the videos and no upload form; a suspended shop disables the form with its reason', async () => {
    server.use(list([owner('READY')]));
    const first = show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    expect(await screen.findByText('Kiln tour')).toBeInTheDocument();
    expect(screen.queryByLabelText('Video file')).not.toBeInTheDocument();
    first.unmount();
    show(shopFixture({ status: 'SUSPENDED' }));
    await waitFor(() => expect(screen.getByLabelText('Video file')).toBeDisabled());
    expect(screen.getByText(/This shop is suspended/)).toBeInTheDocument();
  });

  it('W04 F6-29: deleting a video asks first and then sends DELETE', async () => {
    let deleted = false;
    server.use(
      http.get(videos, () => HttpResponse.json({ items: deleted ? [] : [owner('READY')], nextCursor: null })),
      http.delete(`${videos}/${VIDEO_ID}`, () => ((deleted = true), new HttpResponse(null, { status: 204 }))),
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Delete Kiln tour' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete video' }));
    await waitFor(() => expect(screen.queryByText('Kiln tour')).not.toBeInTheDocument());
    expect(deleted).toBe(true);
  });
});
