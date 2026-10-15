import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemResponse } from '@/lib/test/msw-handlers';
import {
  BOARD_ID,
  ME,
  OTHER,
  commentId,
  commentNode,
  commentView,
  navigationMock,
  origin,
  page,
  postId,
  postView,
  renderWith,
  resetAddress,
} from '@/lib/test/discussions-fixtures';

vi.mock('next/navigation', () => navigationMock());

import { CommentThread } from '@/components/product/discussions/comment-thread';
import { DiscussionList } from '@/components/product/discussions/discussion-list';

const threadUrl = `${origin}/api/posts/${postId(1)}/comments`;
const threadRequests: URL[] = [];
const replyRequests: URL[] = [];
const thread = (handler: (url: URL) => Response | Promise<Response>) =>
  server.use(
    http.get(threadUrl, ({ request }) => {
      const url = new URL(request.url);
      threadRequests.push(url);
      return handler(url);
    }),
  );
const repliesOf = (id: string, handler: (url: URL) => Response | Promise<Response>) =>
  server.use(
    http.get(`${origin}/api/comments/${id}/replies`, ({ request }) => {
      const url = new URL(request.url);
      replyRequests.push(url);
      return handler(url);
    }),
  );

const reply = (n: number, parent: number, depth = 1, extra: Record<string, unknown> = {}) =>
  commentView(n, { parentId: commentId(parent), depth, bodyHtml: `<p>Reply ${n}</p>`, ...extra });

beforeEach(() => {
  threadRequests.length = 0;
  replyRequests.length = 0;
  resetAddress();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

const post = postView(1, { title: 'Does it fit?', commentCount: 2 });
const renderThread = (user?: Parameters<typeof renderWith>[1]) => renderWith(<CommentThread post={post} announce={vi.fn()} />, user);
const commentArticle = (text: string) => screen.getByText(text).closest('article')!;

describe('CommentThread', () => {
  it('W02 AS-49: asks 25 best-first top-level comments and shows each with its embedded replies under it', async () => {
    thread(() =>
      HttpResponse.json(
        page([commentNode(1, { replyCount: 2, replies: [reply(2, 1), reply(3, 1)] }), commentNode(4)]),
      ),
    );
    renderThread();
    await screen.findByText('Comment 1');
    expect(Object.fromEntries(threadRequests[0]!.searchParams)).toEqual({ sort: 'best', limit: '25' });
    const first = commentArticle('Comment 1');
    expect(within(first).getByText('Reply 2')).toBeInTheDocument();
    expect(within(first).getByText('Reply 3')).toBeInTheDocument();
    expect(within(commentArticle('Comment 4')).queryByText('Reply 2')).toBeNull();
    expect(screen.getByRole('group', { name: 'Sort comments' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Sort comments' })).getByRole('button', { name: 'Best' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('W02 AS-49: changing the sort asks that sort again from the first page', async () => {
    thread(() => HttpResponse.json(page([commentNode(1)])));
    const { user } = renderThread();
    await screen.findByText('Comment 1');
    await user.click(within(screen.getByRole('group', { name: 'Sort comments' })).getByRole('button', { name: 'Old' }));
    await waitFor(() => expect(threadRequests.at(-1)!.searchParams.get('sort')).toBe('old'));
    expect(threadRequests.at(-1)!.searchParams.get('cursor')).toBeNull();
  });

  it('W02 AS-49: Show more comments appends the next page and drops a comment it already had', async () => {
    thread((url) =>
      url.searchParams.get('cursor') === 'c1'
        ? HttpResponse.json(page([commentNode(2), commentNode(3)]))
        : HttpResponse.json(page([commentNode(1), commentNode(2)], 'c1')),
    );
    const { user } = renderThread();
    await screen.findByText('Comment 1');
    await user.click(screen.getByRole('button', { name: 'Show more comments' }));
    await screen.findByText('Comment 3');
    expect(screen.getAllByText(/^Comment \d$/).map((n) => n.textContent)).toEqual(['Comment 1', 'Comment 2', 'Comment 3']);
  });

  it('W02 AS-49: "Show 3 more replies" loads the rest after the embedded ones, de-duplicates by commentId and focuses the first added reply', async () => {
    const embedded = [2, 3, 4, 5, 6].map((n) => reply(n, 1));
    thread(() => HttpResponse.json(page([commentNode(1, { replyCount: 8, replies: embedded, hasMoreReplies: true })])));
    repliesOf(commentId(1), () => HttpResponse.json(page([...embedded, reply(7, 1), reply(8, 1), reply(9, 1)])));
    const { user } = renderThread();
    await screen.findByText('Reply 6');
    await user.click(screen.getByRole('button', { name: 'Show 3 more replies' }));
    await screen.findByText('Reply 9');
    const first = commentArticle('Comment 1');
    expect(within(first).getAllByText(/^Reply \d$/).map((n) => n.textContent)).toEqual(['Reply 2', 'Reply 3', 'Reply 4', 'Reply 5', 'Reply 6', 'Reply 7', 'Reply 8', 'Reply 9']);
    expect(Object.fromEntries(replyRequests[0]!.searchParams)).toEqual({ limit: '10' });
    expect(screen.queryByRole('button', { name: /more repl/ })).toBeNull();
    await waitFor(() => expect(commentArticle('Reply 7')).toHaveFocus());
  });

  it('W02 AS-49: further replies continue by the reply cursor', async () => {
    const embedded = [2, 3, 4, 5, 6].map((n) => reply(n, 1));
    thread(() => HttpResponse.json(page([commentNode(1, { replyCount: 12, replies: embedded, hasMoreReplies: true })])));
    repliesOf(commentId(1), (url) =>
      url.searchParams.get('cursor') === 'r1'
        ? HttpResponse.json(page([12, 13].map((n) => reply(n, 1))))
        : HttpResponse.json(page([...embedded, ...[7, 8, 9, 10, 11].map((n) => reply(n, 1))], 'r1')),
    );
    const { user } = renderThread();
    await screen.findByText('Reply 6');
    await user.click(screen.getByRole('button', { name: 'Show 7 more replies' }));
    await screen.findByText('Reply 11');
    await user.click(screen.getByRole('button', { name: 'Show 2 more replies' }));
    await screen.findByText('Reply 13');
    expect(replyRequests.at(-1)!.searchParams.get('cursor')).toBe('r1');
    expect(replyRequests.at(-1)!.searchParams.get('limit')).toBe('5');
  });

  it('W02 AS-49: a reply with replies of its own offers them (Show 2 replies)', async () => {
    thread(() => HttpResponse.json(page([commentNode(1, { replyCount: 1, replies: [reply(2, 1, 1, { replyCount: 2 })] })])));
    repliesOf(commentId(2), () => HttpResponse.json(page([reply(3, 2, 2), reply(4, 2, 2)])));
    const { user } = renderThread();
    await screen.findByText('Reply 2');
    await user.click(screen.getByRole('button', { name: 'Show 2 replies' }));
    expect(await screen.findByText('Reply 4')).toBeInTheDocument();
  });

  it('W02 AS-49: Reply is offered on comments up to depth 7 and not at depth 8', async () => {
    thread(() =>
      HttpResponse.json(
        page([commentNode(1, { replyCount: 2, replies: [reply(2, 1, 7), reply(3, 1, 8)] })]),
      ),
    );
    renderThread();
    await screen.findByText('Reply 3');
    expect(within(commentArticle('Comment 1')).getAllByRole('button', { name: /^Reply to/ })).toHaveLength(2);
    expect(within(commentArticle('Reply 2')).getByRole('button', { name: /^Reply to/ })).toBeInTheDocument();
    expect(within(commentArticle('Reply 3')).queryByRole('button', { name: /^Reply to/ })).toBeNull();
  });

  it('W02 AS-49: deleted comments show the tombstone text for author and moderator and keep their replies', async () => {
    thread(() =>
      HttpResponse.json(
        page([
          commentNode(1, { deleted: true, deletedBy: 'author', authorId: null, bodyHtml: '', replyCount: 1, replies: [reply(2, 1)] }),
          commentNode(3, { deleted: true, deletedBy: 'moderator', authorId: null, bodyHtml: '' }),
        ]),
      ),
    );
    renderThread();
    expect(await screen.findByText('Comment deleted by its author.')).toBeInTheDocument();
    expect(screen.getByText('Comment removed by a moderator.')).toBeInTheDocument();
    expect(screen.getByText('Reply 2')).toBeInTheDocument();
    // Only the kept reply and no tombstone offers votes and a reply control.
    expect(screen.getAllByRole('button', { name: 'Upvote comment' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Reply to/ })).toHaveLength(1);
    expect(within(commentArticle('Reply 2')).getByRole('button', { name: 'Upvote comment' })).toBeInTheDocument();
  });

  it('W02 AS-49: indentation stops growing after three levels at 640 px and below', async () => {
    const l1 = reply(2, 1, 1, { replyCount: 1 });
    thread(() => HttpResponse.json(page([commentNode(1, { replyCount: 1, replies: [l1] })])));
    repliesOf(commentId(2), () => HttpResponse.json(page([reply(3, 2, 2, { replyCount: 1 })])));
    repliesOf(commentId(3), () => HttpResponse.json(page([reply(4, 3, 3, { replyCount: 1 })])));
    repliesOf(commentId(4), () => HttpResponse.json(page([reply(5, 4, 4)])));
    const { user } = renderThread();
    await screen.findByText('Reply 2');
    for (const [shown] of [[2], [3], [4]] as const) {
      await user.click(within(commentArticle(`Reply ${shown}`)).getByRole('button', { name: 'Show 1 reply' }));
    }
    await screen.findByText('Reply 5');
    const group = (text: string) => commentArticle(text).querySelector('[data-replies]') as HTMLElement;
    for (const text of ['Comment 1', 'Reply 2', 'Reply 3']) expect(group(text).className).not.toContain('max-sm:ml-0');
    expect(group('Reply 4').className).toContain('max-sm:ml-0');
    expect(group('Reply 4').className).toContain('max-sm:pl-0');
  });

  it('W02 AS-49: Write a comment posts a top-level comment that appears first with focus, and the post\'s comment count rises', async () => {
    const bodies: unknown[] = [];
    thread(() => HttpResponse.json(page([commentNode(1)])));
    server.use(
      http.get(`${origin}/api/boards/${BOARD_ID}/posts`, () => HttpResponse.json(page([postView(1, { title: 'Does it fit?', commentCount: 1 })]))),
      http.post(threadUrl, async ({ request }) => {
        bodies.push({ body: await request.json(), key: request.headers.get('idempotency-key') });
        return HttpResponse.json(commentView(7, { authorId: ME, bodyHtml: '<p>My <strong>new</strong> comment</p>' }), { status: 201 });
      }),
    );
    window.history.replaceState(null, '', `/products/${BOARD_ID}?tab=discussions&post=${postId(1)}`);
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />);
    await screen.findByText('Comment 1');
    expect(screen.getByText('1 comment')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Write a comment' }), 'My **new** comment');
    await user.click(screen.getByRole('button', { name: 'Post comment' }));
    const added = (await screen.findByText('new')).closest('article')!;
    expect(bodies[0]).toMatchObject({ body: { body: 'My **new** comment' } });
    expect((bodies[0] as { key: string }).key).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(added).toHaveFocus());
    const articles = screen.getAllByRole('article').filter((a) => a.hasAttribute('data-comment'));
    expect(articles[0]).toBe(added);
    expect(screen.getByText('2 comments')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('');
  });

  it('W02 AS-49: Reply opens a form under the comment and the new reply appears under it with focus', async () => {
    thread(() => HttpResponse.json(page([commentNode(1)])));
    const bodies: unknown[] = [];
    server.use(
      http.post(threadUrl, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(reply(8, 1, 1, { authorId: ME, bodyHtml: '<p>Thanks</p>' }), { status: 201 });
      }),
    );
    const { user } = renderThread();
    await screen.findByText('Comment 1');
    await user.click(screen.getByRole('button', { name: 'Reply to comment' }));
    await user.type(screen.getByRole('textbox', { name: 'Write a reply' }), 'Thanks');
    await user.click(screen.getByRole('button', { name: 'Post reply' }));
    const added = (await screen.findByText('Thanks')).closest('article')!;
    expect(bodies).toEqual([{ body: 'Thanks', parentId: commentId(1) }]);
    expect(within(commentArticle('Comment 1')).getByText('Thanks')).toBeInTheDocument();
    await waitFor(() => expect(added).toHaveFocus());
    expect(screen.queryByRole('textbox', { name: 'Write a reply' })).toBeNull();
  });

  it('W02 AS-49: a failed comment keeps the text and shows the cause beside the form; the key survives a retry', async () => {
    thread(() => HttpResponse.json(page([commentNode(1)])));
    const keys: (string | null)[] = [];
    server.use(
      http.post(threadUrl, ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        return keys.length === 1 ? problemResponse(409, 'parent_deleted') : HttpResponse.json(commentView(7, { authorId: ME }), { status: 201 });
      }),
    );
    const { user } = renderThread();
    await screen.findByText('Comment 1');
    await user.type(screen.getByRole('textbox', { name: 'Write a comment' }), 'Hello there');
    await user.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(await screen.findByText("You can't reply to a deleted comment.")).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Hello there');
    await user.click(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
  });

  it('W02 AS-51: a visitor who is not signed in reads the thread, gets "Log in to discuss" instead of the form and no Reply buttons', async () => {
    thread(() => HttpResponse.json(page([commentNode(1)])));
    renderThread(null);
    await screen.findByText('Comment 1');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reply to/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Log in to discuss' })).toHaveAttribute('href', expect.stringContaining('/login?returnTo='));
  });

  it('W02 AS-49: Show discussion puts post=<uuid> in the address and Hide discussion removes it', async () => {
    thread(() => HttpResponse.json(page([commentNode(1)])));
    server.use(http.get(`${origin}/api/boards/${BOARD_ID}/posts`, () => HttpResponse.json(page([postView(1, { title: 'Does it fit?', authorId: OTHER })]))));
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />);
    const toggle = await screen.findByRole('button', { name: 'Show discussion' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(threadRequests).toHaveLength(0); // the thread is requested only when a post is opened
    await user.click(toggle);
    expect(window.location.search).toBe(`?tab=discussions&post=${postId(1)}`);
    expect(await screen.findByText('Comment 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide discussion' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Hide discussion' }));
    expect(window.location.search).toBe('?tab=discussions');
    expect(screen.queryByText('Comment 1')).toBeNull();
  });
});
