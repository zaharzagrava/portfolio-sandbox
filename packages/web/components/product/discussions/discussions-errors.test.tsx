import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemResponse } from '@/lib/test/msw-handlers';
import { BOARD_ID, OTHER, commentNode, navigationMock, origin, page, postId, postView, renderWith, resetAddress } from '@/lib/test/discussions-fixtures';

vi.mock('next/navigation', () => navigationMock());

import { DiscussionsPanel } from '@/components/product/discussions/discussions-panel';

const boardUrl = `${origin}/api/boards/${BOARD_ID}/posts`;
const reads: URL[] = [];
const board = (handler: (url: URL, n: number) => Response | Promise<Response>) =>
  server.use(
    http.get(boardUrl, ({ request }) => {
      const url = new URL(request.url);
      reads.push(url);
      return handler(url, reads.length);
    }),
  );
const OK = () => HttpResponse.json(page([postView(1, { title: 'Does it fit?', authorId: OTHER })]));

beforeEach(() => {
  reads.length = 0;
  resetAddress();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('Discussions error forms', () => {
  it.each([
    [409, 'board_closed', 'Discussions are closed for this product.', undefined],
    [429, 'rate_limited', "You're posting too fast. Try again in 12 seconds.", 12],
    [503, 'service_unavailable', 'Discussions are temporarily unavailable. Try again.', undefined],
    [500, 'internal_error', 'Discussions are temporarily unavailable. Try again.', undefined],
    [422, 'idempotency_key_required', 'Something went wrong. Reload the page and try again.', undefined],
    [403, 'forbidden', "You can't do that.", undefined],
  ])('W02 AS-52: Post answered %d %s reads "%s" beside the form and keeps the text', async (status, code, text, retryAfter) => {
    board(OK);
    server.use(http.post(boardUrl, () => problemResponse(status, code, { ...(retryAfter ? { retryAfter } : {}) })));
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Start a discussion' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    const form = screen.getByRole('form', { name: 'Start a discussion' });
    expect(await within(form).findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Keep me');
    expect(screen.getByRole('article', { name: 'Does it fit?' })).toBeInTheDocument(); // the list is untouched
  });

  it('W02 AS-52: a 5xx on a write shows the reference of the request', async () => {
    board(OK);
    server.use(http.post(boardUrl, () => problemResponse(500, 'internal_error', { requestId: 'req-77' })));
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Start a discussion' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByText('req-77')).toBeInTheDocument();
  });

  it('W02 AS-52: degraded:true shows "Showing a reduced list. Some discussions may be missing." above the posts', async () => {
    board(() => HttpResponse.json(page([postView(1, { title: 'Does it fit?' })], null, { degraded: true })));
    renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    expect(await screen.findByText('Showing a reduced list. Some discussions may be missing.')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Does it fit?' })).toBeInTheDocument();
  });

  it('W02 AS-52: 404 board_not_found shows "Discussions aren\'t available for this product." and no retry', async () => {
    board(() => problemResponse(404, 'board_not_found'));
    renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    expect(await screen.findByText("Discussions aren't available for this product.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('W02 AS-52: 429 on the list shows the wait with Try again', async () => {
    board((_url, n) => (n === 1 ? problemResponse(429, 'rate_limited', { retryAfter: 5 }) : OK()));
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    expect(await screen.findByText('Too many requests. Try again in 5 seconds.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('article', { name: 'Does it fit?' })).toBeInTheDocument();
    expect(screen.queryByText(/Too many requests/)).toBeNull();
  });

  it('W02 AS-52: a failed Show more keeps the loaded posts, shows the cause with Try again, and Try again asks the same page', async () => {
    board((url) => {
      if (url.searchParams.get('cursor') !== 'c1') return HttpResponse.json(page([postView(1, { title: 'First' })], 'c1'));
      return reads.filter((r) => r.searchParams.get('cursor') === 'c1').length === 1
        ? problemResponse(503, 'service_unavailable')
        : HttpResponse.json(page([postView(2, { title: 'Second' })]));
    });
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    await screen.findByRole('article', { name: 'First' });
    await user.click(screen.getByRole('button', { name: 'Show more discussions' }));
    expect(await screen.findByText('Discussions are temporarily unavailable. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'First' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('article', { name: 'Second' })).toBeInTheDocument();
    expect(reads.at(-1)!.searchParams.get('cursor')).toBe('c1');
  });

  it('W02 AS-52: invalid_cursor reloads the first page and says so', async () => {
    board((url, n) => {
      if (n === 1) return HttpResponse.json(page([postView(1, { title: 'First' })], 'stale'));
      if (url.searchParams.get('cursor')) return problemResponse(400, 'invalid_cursor');
      return HttpResponse.json(page([postView(1, { title: 'First' }), postView(3, { title: 'Fresh' })]));
    });
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    await screen.findByRole('article', { name: 'First' });
    await user.click(screen.getByRole('button', { name: 'Show more discussions' }));
    expect(await screen.findByRole('article', { name: 'Fresh' })).toBeInTheDocument();
    expect(screen.getByText('That page is no longer available. Showing the first page.')).toBeInTheDocument();
    expect(reads.at(-1)!.searchParams.has('cursor')).toBe(false);
  });

  it('W02 AS-52: voting on a post that vanished removes it with "That post is no longer available."', async () => {
    board(() => HttpResponse.json(page([postView(1, { title: 'Gone soon' }), postView(2, { title: 'Stays' })])));
    server.use(http.put(`${origin}/api/votes/${postId(1)}`, () => problemResponse(404, 'target_not_found')));
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Upvote Gone soon' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Gone soon' })).toBeNull());
    expect(screen.getByRole('article', { name: 'Stays' })).toBeInTheDocument();
    expect(screen.getByText('That post is no longer available.').closest('[role="status"]')).not.toBeNull();
  });

  it('W02 AS-52: replying under a comment that vanished removes it with "That comment is no longer available."', async () => {
    resetAddress(`?tab=discussions&post=${postId(1)}`);
    board(() => HttpResponse.json(page([postView(1, { title: 'Does it fit?' })])));
    server.use(
      http.get(`${origin}/api/posts/${postId(1)}/comments`, () => HttpResponse.json(page([commentNode(1), commentNode(2)]))),
      http.post(`${origin}/api/posts/${postId(1)}/comments`, () => problemResponse(404, 'parent_not_found')),
    );
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    await screen.findByText('Comment 1');
    await user.click(screen.getAllByRole('button', { name: 'Reply to comment' })[0]!);
    await user.type(screen.getByRole('textbox', { name: 'Write a reply' }), 'Anyone there?');
    await user.click(screen.getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(screen.queryByText('Comment 1')).toBeNull());
    expect(screen.getByText('Comment 2')).toBeInTheDocument();
    expect(screen.getByText('That comment is no longer available.')).toBeInTheDocument();
  });

  it('W02 AS-52: a thread that fails shows the cause beside the thread with Try again; the post stays', async () => {
    resetAddress(`?tab=discussions&post=${postId(1)}`);
    board(() => HttpResponse.json(page([postView(1, { title: 'Does it fit?' })])));
    let calls = 0;
    server.use(
      http.get(`${origin}/api/posts/${postId(1)}/comments`, () => {
        calls += 1;
        return calls === 1 ? problemResponse(503, 'service_unavailable') : HttpResponse.json(page([commentNode(1)]));
      }),
    );
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    const article = await screen.findByRole('article', { name: 'Does it fit?' });
    expect(await within(article).findByText('Discussions are temporarily unavailable. Try again.')).toBeInTheDocument();
    await user.click(within(article).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Comment 1')).toBeInTheDocument();
  });

  it('W02 AS-74: offline on load shows the offline copy and "Reconnecting…" busy, and the online event loads the list', async () => {
    let online = false;
    board((_url, n) => (online || n > 1 ? OK() : Response.error()));
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    expect(await screen.findByText('You appear to be offline. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByText('Reconnecting…').closest('[aria-busy="true"]')).not.toBeNull();
    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(await screen.findByRole('article', { name: 'Does it fit?' })).toBeInTheDocument();
  });
});
