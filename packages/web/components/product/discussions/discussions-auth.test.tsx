import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { problemResponse } from '@/lib/test/msw-handlers';
import { BOARD_ID, OTHER, commentNode, navigationMock, origin, page, postId, postView, renderWith, resetAddress } from '@/lib/test/discussions-fixtures';

vi.mock('next/navigation', () => navigationMock());

import { DiscussionsPanel } from '@/components/product/discussions/discussions-panel';

const boardUrl = `${origin}/api/boards/${BOARD_ID}/posts`;
const returnTo = (search: string) => `/login?returnTo=${encodeURIComponent(`/products/${BOARD_ID}${search}`)}`;

beforeEach(() => {
  resetAddress();
  rearmSessionEnd();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  server.use(http.get(boardUrl, () => HttpResponse.json(page([postView(1, { title: 'Does it fit?', authorId: OTHER })]))));
});
afterEach(() => {
  setSessionEndHandler(null);
  vi.restoreAllMocks();
});

describe('Discussions and sign-in', () => {
  it('W02 AS-51: a visitor reads the list and counts and sees "Log in to discuss" instead of Start a discussion, with returnTo', async () => {
    resetAddress('?tab=discussions&sort=top&window=week');
    renderWith(<DiscussionsPanel productId={BOARD_ID} />, null);
    expect(await screen.findByRole('article', { name: 'Does it fit?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a discussion' })).toBeNull();
    const link = screen.getByRole('link', { name: 'Log in to discuss' });
    expect(link).toHaveAttribute('href', returnTo('?tab=discussions&sort=top&window=week'));
  });

  it('W02 AS-51: the sign-in link also carries the expanded post', async () => {
    resetAddress(`?tab=discussions&post=${postId(1)}`);
    server.use(http.get(`${origin}/api/posts/${postId(1)}/comments`, () => HttpResponse.json(page([commentNode(1)]))));
    renderWith(<DiscussionsPanel productId={BOARD_ID} />, null);
    await screen.findByText('Comment 1');
    const links = screen.getAllByRole('link', { name: 'Log in to discuss' });
    expect(links.length).toBeGreaterThanOrEqual(2); // the panel's, and the one that replaces the comment form
    for (const link of links) expect(link).toHaveAttribute('href', returnTo(`?tab=discussions&post=${postId(1)}`));
  });

  it('W02 AS-51: a visitor\'s vote press shows "Sign in to vote." with a link back to this page and sends nothing', async () => {
    const puts = vi.fn();
    server.use(http.put(`${origin}/api/votes/${postId(1)}`, () => puts() as never));
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />, null);
    await user.click(await screen.findByRole('button', { name: 'Upvote Does it fit?' }));
    const article = screen.getByRole('article', { name: 'Does it fit?' });
    expect(within(article).getByText('Sign in to vote.')).toBeInTheDocument();
    expect(within(article).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', returnTo('?tab=discussions'));
    expect(puts).not.toHaveBeenCalled();
  });

  it('W02 AS-51: a signed-in member gets Start a discussion and no sign-in link', async () => {
    renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    expect(await screen.findByRole('button', { name: 'Start a discussion' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in to discuss' })).toBeNull();
  });

  it('W02 AS-51: a 401 on Post runs the session-ended flow once, keeps the typed text and posts nothing twice', async () => {
    const ended = vi.fn();
    setSessionEndHandler(ended);
    const posts = vi.fn();
    server.use(
      http.post(boardUrl, () => {
        posts();
        return problemResponse(401, 'unauthorized');
      }),
    );
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Start a discussion' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Typed title');
    await user.type(screen.getByRole('textbox', { name: 'Details (optional)' }), 'Typed details');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Your session ended. Sign in again to continue.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Typed title');
    expect(screen.getByRole('textbox', { name: 'Details (optional)' })).toHaveValue('Typed details');
    expect(posts).toHaveBeenCalledTimes(1);
  });

  it('W02 AS-51: a 401 on a vote and then on a comment still runs the flow once', async () => {
    const ended = vi.fn();
    setSessionEndHandler(ended);
    resetAddress(`?tab=discussions&post=${postId(1)}`);
    server.use(
      http.get(`${origin}/api/posts/${postId(1)}/comments`, () => HttpResponse.json(page([commentNode(1)]))),
      http.put(`${origin}/api/votes/${postId(1)}`, () => problemResponse(401, 'unauthorized')),
      http.post(`${origin}/api/posts/${postId(1)}/comments`, () => problemResponse(401, 'unauthorized')),
    );
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Upvote Does it fit?' }));
    await waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    await user.type(await screen.findByRole('textbox', { name: 'Write a comment' }), 'Still here');
    await user.click(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findAllByText('Your session ended. Sign in again to continue.');
    expect(ended).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Still here');
  });
});
