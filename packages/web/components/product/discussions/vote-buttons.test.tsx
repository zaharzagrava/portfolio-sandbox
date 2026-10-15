import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import type { PostPage } from '@marketplace-sandbox/contracts';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemResponse } from '@/lib/test/msw-handlers';
import { queryKeys } from '@/lib/query-keys';
import { BOARD_ID, ME, OTHER, navigationMock, newClient, origin, postId, postView, resetAddress } from '@/lib/test/discussions-fixtures';

vi.mock('next/navigation', () => navigationMock());

import { VoteButtons } from '@/components/product/discussions/vote-buttons';

const key = queryKeys.discussions.board(BOARD_ID, { sort: 'hot' });
type Sent = { value: unknown; csrf: string | null };
let sent: Sent[];
type Reply = Response | Promise<Response>;

const vote = (handler: (n: number) => Reply) =>
  server.use(
    http.put(`${origin}/api/votes/${postId(1)}`, async ({ request }) => {
      sent.push({ value: ((await request.json()) as { value: unknown }).value, csrf: request.headers.get('x-csrf-token') });
      return handler(sent.length);
    }),
  );
const result = (ups: number, downs: number, myVote: 1 | -1 | 0) =>
  HttpResponse.json({ targetId: postId(1), targetType: 'post', ups, downs, score: ups - downs, myVote });

/** The post lives in the board cache; the buttons read it back from there, as in the list. */
function Harness() {
  const { data } = useInfiniteQuery({
    queryKey: key,
    queryFn: (): Promise<PostPage> => Promise.reject(new Error('seeded')),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: () => undefined,
    enabled: false,
  });
  const post = data!.pages[0]!.items[0]!;
  return (
    <VoteButtons
      target={{ id: post.postId, kind: 'post', authorId: post.authorId, name: post.title }}
      votes={{ ups: post.ups, downs: post.downs, score: post.score, myVote: post.myVote }}
    />
  );
}

function renderSeeded(post: Record<string, unknown>, user: Parameters<typeof newClient>[0] = { id: ME, email: 'me@example.com', role: 'USER' }) {
  const client = newClient(user);
  client.setQueryData(key, { pages: [{ items: [postView(1, { title: 'Does it fit?', ups: 2, downs: 1, score: 1, ...post })], nextCursor: null }], pageParams: [undefined] });
  rtlRender(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return { client, user: userEvent.setup() };
}

const up = () => screen.getByRole('button', { name: 'Upvote Does it fit?' });
const down = () => screen.getByRole('button', { name: 'Downvote Does it fit?' });
const cachedPost = (client: QueryClient) => (client.getQueryData(key) as { pages: { items: { score: number; myVote: number; ups: number }[] }[] }).pages[0]!.items[0]!;

beforeEach(() => {
  sent = [];
  resetAddress();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VoteButtons', () => {
  it('W02 AS-48: two buttons named with the title show myVote with aria-pressed and the score', () => {
    renderSeeded({ myVote: 1 });
    expect(up()).toHaveAttribute('aria-pressed', 'true');
    expect(down()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('W02 AS-48: the names of a comment\'s buttons say "comment"', () => {
    const client = newClient();
    rtlRender(
      <QueryClientProvider client={client}>
        <VoteButtons target={{ id: postId(2), kind: 'comment', authorId: OTHER, name: 'comment' }} votes={{ ups: 0, downs: 0, score: 0, myVote: 0 }} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Upvote comment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Downvote comment' })).toBeInTheDocument();
  });

  it('W02 AS-48: Upvote updates the score and pressed state at once, sends {value: 1}, then shows the server counts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vote(async () => {
      await gate;
      return result(3, 1, 1);
    });
    const { user, client } = renderSeeded({ myVote: 0 });
    await user.click(up());
    expect(up()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('2')).toBeInTheDocument(); // 1 + 1, before the answer
    expect(cachedPost(client)).toMatchObject({ myVote: 1, ups: 3 });
    release();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ value: 1, csrf: 'tok' });
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
  });

  it('W02 AS-48: flipping sends -1 and pressing the pressed button again retracts with 0', async () => {
    vote((n) => (n === 1 ? result(1, 2, -1) : result(1, 1, 0)));
    const { user } = renderSeeded({ myVote: 1, ups: 2, downs: 1, score: 1 });
    await user.click(down());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.value).toBe(-1);
    await waitFor(() => expect(down()).toHaveAttribute('aria-pressed', 'true'));
    expect(up()).toHaveAttribute('aria-pressed', 'false');
    await user.click(down());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.value).toBe(0);
    await waitFor(() => expect(down()).toHaveAttribute('aria-pressed', 'false'));
  });

  it('W02 AS-48: on a failure the previous state returns and the cause is shown beside the buttons', async () => {
    vote(() => problemResponse(429, 'rate_limited', { retryAfter: 20 }));
    const { user, client } = renderSeeded({ myVote: 0 });
    await user.click(up());
    expect(await screen.findByText("You're voting too fast. Try again in 20 seconds.")).toBeInTheDocument();
    expect(up()).toHaveAttribute('aria-pressed', 'false');
    expect(cachedPost(client)).toMatchObject({ myVote: 0, ups: 2, score: 1 });
  });

  it.each([
    [403, 'forbidden', "You can't do that."],
    [503, 'service_unavailable', 'Discussions are temporarily unavailable. Try again.'],
    [409, 'target_deleted', 'That comment was deleted.'],
    [500, 'internal_error', 'Discussions are temporarily unavailable. Try again.'],
  ])('W02 AS-48: %d %s reads "%s"', async (status, code, text) => {
    vote(() => problemResponse(status, code));
    const { user } = renderSeeded({});
    await user.click(up());
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(up()).toHaveAttribute('aria-pressed', 'false');
  });

  it('W02 AS-48: for the member\'s own post the buttons are aria-disabled with the reason, and no request is sent', async () => {
    vote(() => result(1, 0, 1));
    const { user } = renderSeeded({ authorId: ME });
    expect(up()).toHaveAttribute('aria-disabled', 'true');
    expect(down()).toHaveAttribute('aria-disabled', 'true');
    expect(up()).toHaveAccessibleDescription("You can't vote on your own post.");
    await user.click(up());
    expect(sent).toHaveLength(0);
    expect(screen.getAllByText("You can't vote on your own post.").length).toBeGreaterThan(0);
  });

  it('W02 AS-48: a visitor who is not signed in gets "Sign in to vote." with a link that returns to this page', async () => {
    resetAddress('?tab=discussions&sort=top&window=week');
    vote(() => result(1, 0, 1));
    const { user } = renderSeeded({}, null);
    expect(screen.queryByText('Sign in to vote.')).toBeNull();
    await user.click(up());
    expect(screen.getByText('Sign in to vote.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent(`/products/${BOARD_ID}?tab=discussions&sort=top&window=week`)}`);
    expect(sent).toHaveLength(0);
  });

  it('W02 AS-48: vote_in_progress is retried once after Retry-After', async () => {
    vote((n) => (n === 1 ? problemResponse(409, 'vote_in_progress', { retryAfter: 1 }) : result(3, 1, 1)));
    const { user } = renderSeeded({});
    await user.click(up());
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(sent).toHaveLength(2), { timeout: 3000 });
    await waitFor(() => expect(cachedPostValue()).toBe(1), { timeout: 3000 });
    function cachedPostValue() {
      return up().getAttribute('aria-pressed') === 'true' ? 1 : 0;
    }
    expect(screen.queryByText(/Try again/)).toBeNull();
  });

  it('W02 AS-48: vote_in_progress twice shows the failure and restores the previous state (one retry only)', async () => {
    vote(() => problemResponse(409, 'vote_in_progress', { retryAfter: 0 }));
    const { user } = renderSeeded({});
    await user.click(up());
    await waitFor(() => expect(sent).toHaveLength(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(sent).toHaveLength(2);
    expect(up()).toHaveAttribute('aria-pressed', 'false');
    expect(await screen.findByText("Something didn't work. Check the details and try again.")).toBeInTheDocument();
  });

  it('W02 AS-48: at most one request is in flight; a second press meanwhile is sent after the first with the final value', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vote(async (n) => {
      if (n === 1) {
        await gate;
        return result(3, 1, 1);
      }
      return result(2, 2, -1);
    });
    const { user } = renderSeeded({ myVote: 0 });
    await user.click(up());
    await user.click(down()); // flips while the first is pending
    expect(sent).toHaveLength(1);
    expect(down()).toHaveAttribute('aria-pressed', 'true');
    release();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.value)).toEqual([1, -1]);
    await waitFor(() => expect(down()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('W02 AS-48: a press that retracts while the first is pending is sent after it as 0', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vote(async () => {
      await gate;
      return result(3, 1, 1);
    });
    const { user } = renderSeeded({ myVote: 0 });
    await user.click(up());
    await user.click(up()); // retract while pending: final value 0
    release();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.value)).toEqual([1, 0]);
  });
});
