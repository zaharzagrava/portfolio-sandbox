import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemResponse } from '@/lib/test/msw-handlers';
import { BOARD_ID, ME, OTHER, commentId, commentNode, navigationMock, origin, page, postId, postView, renderWith, resetAddress } from '@/lib/test/discussions-fixtures';
import type { SessionUser } from '@/hooks/use-auth';

vi.mock('next/navigation', () => navigationMock());

import { CommentThread } from '@/components/product/discussions/comment-thread';
import { DeleteDialog } from '@/components/product/discussions/delete-dialog';
import { DiscussionList } from '@/components/product/discussions/discussion-list';

const boardUrl = `${origin}/api/boards/${BOARD_ID}/posts`;
let boardReads: number;
let deletes: string[];

const board = (posts = [postView(1, { title: 'Mine', authorId: ME }), postView(2, { title: 'Theirs', authorId: OTHER })]) =>
  server.use(
    http.get(boardUrl, () => {
      boardReads += 1;
      return HttpResponse.json(page(posts));
    }),
  );
const deletePost = (n: number, handler: () => Response) =>
  server.use(
    http.delete(`${origin}/api/posts/${postId(n)}`, () => {
      deletes.push(postId(n));
      return handler();
    }),
  );
const noContent = () => new HttpResponse(null, { status: 204 });
const admin: SessionUser = { id: '33333333-3333-4333-8333-333333333333', email: 'a@example.com', role: 'ADMIN' };
const moderator: SessionUser = { ...admin, role: 'MODERATOR' };
const member: SessionUser = { id: ME, email: 'me@example.com', role: 'USER' };

beforeEach(() => {
  boardReads = 0;
  deletes = [];
  resetAddress();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

const deleteButton = (article: HTMLElement) => within(article).queryByRole('button', { name: /^Delete/ });

describe('DeleteDialog', () => {
  it('W02 AS-50: Delete is shown to the author and to ADMIN and MODERATOR, and hidden for everyone else', async () => {
    board();
    const { unmount } = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, member);
    await screen.findByRole('article', { name: 'Mine' });
    expect(deleteButton(screen.getByRole('article', { name: 'Mine' }))).toBeInTheDocument();
    expect(deleteButton(screen.getByRole('article', { name: 'Theirs' }))).toBeNull();
    unmount();
    for (const role of [admin, moderator]) {
      const view = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, role);
      await screen.findByRole('article', { name: 'Mine' });
      expect(deleteButton(screen.getByRole('article', { name: 'Mine' }))).toBeInTheDocument();
      expect(deleteButton(screen.getByRole('article', { name: 'Theirs' }))).toBeInTheDocument();
      view.unmount();
    }
    renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, { ...member, id: '44444444-4444-4444-8444-444444444444' });
    await screen.findByRole('article', { name: 'Mine' });
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it('W02 AS-50: nothing is offered to a visitor who is not signed in', async () => {
    renderWith(<DeleteDialog kind="post" id={postId(1)} authorId={ME} name="Mine" announce={vi.fn()} />, null);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('W02 AS-50: the dialog asks "Delete this post? This can\'t be undone." with Cancel focused first', async () => {
    board();
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, member);
    await screen.findByRole('article', { name: 'Mine' });
    await user.click(deleteButton(screen.getByRole('article', { name: 'Mine' }))!);
    const dialog = await screen.findByRole('dialog', { name: "Delete this post? This can't be undone." });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(deletes).toHaveLength(0);
  });

  it('W02 AS-50: Escape closes the dialog without deleting and returns focus to the Delete button', async () => {
    board();
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, member);
    const trigger = deleteButton((await screen.findByRole('article', { name: 'Mine' })))!;
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
    expect(deletes).toHaveLength(0);
  });

  it('W02 AS-50: Cancel closes the dialog and keeps the post', async () => {
    board();
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, member);
    await user.click(deleteButton(await screen.findByRole('article', { name: 'Mine' }))!);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('article', { name: 'Mine' })).toBeInTheDocument();
  });

  it('W02 AS-50: 204 removes the post from the list and the status says "Post deleted."', async () => {
    board();
    deletePost(1, noContent);
    const announce = vi.fn();
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={announce} />, member);
    await user.click(deleteButton(await screen.findByRole('article', { name: 'Mine' }))!);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Mine' })).toBeNull());
    expect(announce).toHaveBeenCalledWith('Post deleted.');
    expect(deletes).toEqual([postId(1)]);
    expect(screen.getByRole('article', { name: 'Theirs' })).toBeInTheDocument();
  });

  it('W02 AS-50: 204 on a comment turns it into a tombstone and the status says "Comment deleted."', async () => {
    server.use(
      http.get(`${origin}/api/posts/${postId(1)}/comments`, () => HttpResponse.json(page([commentNode(1, { authorId: ME, bodyHtml: '<p>Mine to remove</p>' })]))),
      http.delete(`${origin}/api/comments/${commentId(1)}`, () => noContent()),
    );
    const announce = vi.fn();
    const { user } = renderWith(<CommentThread post={postView(1)} announce={announce} />, member);
    await screen.findByText('Mine to remove');
    await user.click(screen.getByRole('button', { name: 'Delete comment' }));
    expect(await screen.findByRole('dialog', { name: "Delete this comment? This can't be undone." })).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Comment deleted by its author.')).toBeInTheDocument();
    expect(screen.queryByText('Mine to remove')).toBeNull();
    expect(announce).toHaveBeenCalledWith('Comment deleted.');
  });

  it('W02 AS-50: a moderator\'s delete of someone else\'s comment reads "removed by a moderator"', async () => {
    server.use(
      http.get(`${origin}/api/posts/${postId(1)}/comments`, () => HttpResponse.json(page([commentNode(1, { bodyHtml: '<p>Spam</p>' })]))),
      http.delete(`${origin}/api/comments/${commentId(1)}`, () => noContent()),
    );
    const { user } = renderWith(<CommentThread post={postView(1)} announce={vi.fn()} />, moderator);
    await screen.findByText('Spam');
    await user.click(screen.getByRole('button', { name: 'Delete comment' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Comment removed by a moderator.')).toBeInTheDocument();
  });

  it('W02 AS-50: 403 shows "You can\'t do that." beside Delete and refreshes the list', async () => {
    board();
    deletePost(1, () => problemResponse(403, 'forbidden'));
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, member);
    await user.click(deleteButton(await screen.findByRole('article', { name: 'Mine' }))!);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await within(screen.getByRole('article', { name: 'Mine' })).findByText("You can't do that.")).toBeInTheDocument();
    await waitFor(() => expect(boardReads).toBe(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('W02 AS-50: 404 removes the post and says it is no longer available', async () => {
    board();
    deletePost(1, () => problemResponse(404, 'post_not_found'));
    const announce = vi.fn();
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={announce} />, member);
    await user.click(deleteButton(await screen.findByRole('article', { name: 'Mine' }))!);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Mine' })).toBeNull());
    expect(announce).toHaveBeenCalledWith('That post is no longer available.');
  });

  it('W02 AS-50: 409 shows the catalogue text beside Delete and refreshes the item', async () => {
    board();
    deletePost(1, () => problemResponse(409, 'board_closed'));
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, member);
    await user.click(deleteButton(await screen.findByRole('article', { name: 'Mine' }))!);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Discussions are closed for this product.')).toBeInTheDocument();
    await waitFor(() => expect(boardReads).toBe(2));
  });

  it('W02 AS-74: a delete made offline fails at once and keeps the post', async () => {
    board();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    deletePost(1, noContent);
    const { user } = renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, member);
    await user.click(deleteButton(await screen.findByRole('article', { name: 'Mine' }))!);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('You appear to be offline. Check your connection and try again.')).toBeInTheDocument();
    expect(deletes).toHaveLength(0);
    expect(screen.getByRole('article', { name: 'Mine' })).toBeInTheDocument();
  });
});
