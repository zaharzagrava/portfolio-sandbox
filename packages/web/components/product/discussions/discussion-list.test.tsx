import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemResponse } from '@/lib/test/msw-handlers';
import { BOARD_ID, ME, OTHER, navigationMock, origin, page, postId, postView, renderWith, resetAddress } from '@/lib/test/discussions-fixtures';

vi.mock('next/navigation', () => navigationMock());

import { DiscussionList } from '@/components/product/discussions/discussion-list';

const boardUrl = `${origin}/api/boards/${BOARD_ID}/posts`;
const requests: URL[] = [];
const answer = (handler: (url: URL) => Response | Promise<Response>) =>
  server.use(
    http.get(boardUrl, ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return handler(url);
    }),
  );

const NOW = new Date('2026-10-14T12:00:00.000Z');

function setup(user: Parameters<typeof renderWith>[1] = undefined) {
  return renderWith(<DiscussionList productId={BOARD_ID} announce={vi.fn()} />, user);
}

beforeEach(() => {
  requests.length = 0;
  resetAddress();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('DiscussionList', () => {
  it('W02 AS-45: asks the first 20 hot posts and shows title, excerpt, time, author label, score and comment count', async () => {
    answer(() =>
      HttpResponse.json(
        page([postView(1, { title: 'Does it fit?', bodyHtml: '<p>Planning to use it with a <strong>laptop</strong>.</p>', score: 4, commentCount: 3, createdAt: '2026-10-14T09:00:00.000Z' })]),
      ),
    );
    setup();
    const article = await screen.findByRole('article', { name: 'Does it fit?' });
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ sort: 'hot', limit: '20' });
    expect(within(article).getByRole('heading', { level: 3, name: 'Does it fit?' })).toBeInTheDocument();
    expect(within(article).getByText('laptop').tagName).toBe('STRONG');
    expect(within(article).getByText('Community member')).toBeInTheDocument();
    expect(within(article).getByText('3 hours ago')).toBeInTheDocument();
    expect(within(article).getByText('3 comments')).toBeInTheDocument();
    expect(within(article).getByText('4')).toBeInTheDocument();
    const time = article.querySelector('time')!;
    expect(time).toHaveAttribute('datetime', '2026-10-14T09:00:00.000Z');
    expect(time).toHaveAttribute('title', expect.stringContaining('09:00'));
  });

  it('W02 AS-45: the author label is "You" for the signed-in author and "Community member" for a tombstone author', async () => {
    answer(() => HttpResponse.json(page([postView(1, { title: 'Mine', authorId: ME }), postView(2, { title: 'Theirs', authorId: OTHER })])));
    setup();
    expect(within(await screen.findByRole('article', { name: 'Mine' })).getByText('You')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Theirs' })).getByText('Community member')).toBeInTheDocument();
  });

  it('W02 AS-45: relative times run to 30 days, then "Mon D, YYYY"', async () => {
    answer(() =>
      HttpResponse.json(
        page([
          postView(1, { title: 'A', createdAt: '2026-10-14T11:59:30.000Z' }),
          postView(2, { title: 'B', createdAt: '2026-10-12T12:00:00.000Z' }),
          postView(3, { title: 'C', createdAt: '2026-08-01T10:15:00.000Z' }),
        ]),
      ),
    );
    setup();
    await screen.findByRole('article', { name: 'A' });
    expect(within(screen.getByRole('article', { name: 'A' })).getByText('just now')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'B' })).getByText('2 days ago')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'C' })).getByText('Aug 1, 2026')).toBeInTheDocument();
  });

  it('W02 AS-45: sort and window live in the address; window only with top; a change starts again at the first page', async () => {
    answer(() => HttpResponse.json(page([postView(1)])));
    const { user } = setup();
    await screen.findByRole('article', { name: 'Post 1' });
    const sort = screen.getByRole('group', { name: 'Sort discussions' });
    expect(within(sort).getByRole('button', { name: 'Hot' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Time')).toBeNull();

    await user.click(within(sort).getByRole('button', { name: 'Top' }));
    expect(window.location.search).toBe('?tab=discussions&sort=top');
    const time = await screen.findByLabelText('Time');
    expect(time).toHaveValue('all');
    expect(Array.from((time as HTMLSelectElement).options).map((o) => o.text)).toEqual(['Today', 'This week', 'This month', 'This year', 'All time']);
    await waitFor(() => expect(requests.at(-1)!.searchParams.get('sort')).toBe('top'));
    expect(requests.at(-1)!.searchParams.get('window')).toBe('all');

    await user.selectOptions(time, 'week');
    expect(window.location.search).toBe('?tab=discussions&sort=top&window=week');
    await waitFor(() => expect(requests.at(-1)!.searchParams.get('window')).toBe('week'));
    expect(requests.at(-1)!.searchParams.get('cursor')).toBeNull();

    await user.click(within(sort).getByRole('button', { name: 'New' }));
    expect(window.location.search).toBe('?tab=discussions&sort=new');
    await waitFor(() => expect(requests.at(-1)!.searchParams.get('sort')).toBe('new'));
    expect(requests.at(-1)!.searchParams.has('window')).toBe(false);
  });

  it('W02 AS-45: the view in the address is what is asked on load', async () => {
    resetAddress('?tab=discussions&sort=top&window=month');
    answer(() => HttpResponse.json(page([postView(1)])));
    setup();
    await screen.findByRole('article', { name: 'Post 1' });
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ sort: 'top', window: 'month', limit: '20' });
    expect(screen.getByLabelText('Time')).toHaveValue('month');
  });

  it('W02 AS-45: Show more discussions appends the next page by cursor, drops posts it already has, and moves focus to the first new one', async () => {
    answer((url) =>
      url.searchParams.get('cursor') === 'c1'
        ? HttpResponse.json(page([postView(2, { title: 'Second' }), postView(3, { title: 'Third' })]))
        : HttpResponse.json(page([postView(1, { title: 'First' }), postView(2, { title: 'Second' })], 'c1')),
    );
    const { user } = setup();
    await screen.findByRole('article', { name: 'First' });
    await user.click(screen.getByRole('button', { name: 'Show more discussions' }));
    await screen.findByRole('article', { name: 'Third' });
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-labelledby') && within(a).getByRole('heading').textContent)).toEqual(['First', 'Second', 'Third']);
    expect(screen.queryByRole('button', { name: 'Show more discussions' })).toBeNull();
    expect(requests.at(-1)!.searchParams.get('cursor')).toBe('c1');
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Third' })).getByRole('heading', { level: 3 })).toHaveFocus());
  });

  it('W02 AS-45: no posts shows the empty text', async () => {
    answer(() => HttpResponse.json(page([])));
    setup();
    expect(await screen.findByText('No discussions yet. Be the first to ask.')).toBeInTheDocument();
  });

  it('W02 AS-45: while loading, three skeleton rows and a busy region show; nothing is claimed empty', async () => {
    answer(() => new Promise<Response>(() => undefined));
    setup();
    const region = await screen.findByTestId('discussion-skeleton');
    expect(region.children).toHaveLength(3);
    expect(region.closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText('No discussions yet. Be the first to ask.')).toBeNull();
  });

  it('W02 AS-53: each post is an article named by its title; the post titles are h3 and sit under the panel heading level', async () => {
    answer(() => HttpResponse.json(page([postView(1, { title: 'First' }), postView(2, { title: 'Second' })])));
    setup();
    await screen.findByRole('article', { name: 'First' });
    expect(screen.getAllByRole('heading').map((h) => h.tagName)).toEqual(['H3', 'H3']);
    expect(screen.getByRole('group', { name: 'Sort discussions' })).toBeInTheDocument();
  });

  it('W02 AS-47: a post body is sanitised before it is inserted (script, handler, javascript: link)', async () => {
    answer(() =>
      HttpResponse.json(
        page([postView(1, { bodyHtml: '<p onclick="x()">hi <a href="javascript:alert(1)">bad</a> <a href="https://example.com/a">ok</a></p><script>alert(1)</script><img src=x onerror=alert(1)>' })]),
      ),
    );
    setup();
    const article = await screen.findByRole('article', { name: 'Post 1' });
    expect(article.querySelector('script, img')).toBeNull();
    expect(article.querySelector('[onclick]')).toBeNull();
    const links = article.querySelectorAll('a[href]');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('rel', 'nofollow ugc noopener noreferrer');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(article).toHaveTextContent('hi bad ok'); // the unsafe link kept its text
  });

  it('W02 AS-45: the post named by the address is expanded, and an unknown id is dropped from the address after the list loads', async () => {
    resetAddress(`?tab=discussions&post=${postId(9)}`);
    answer(() => HttpResponse.json(page([postView(1)])));
    setup();
    await screen.findByRole('article', { name: 'Post 1' });
    await waitFor(() => expect(window.location.search).toBe('?tab=discussions'));
  });

  it('W02 AS-45: a failed first load shows the problem with Try again and no list', async () => {
    answer(() => problemResponse(503, 'service_unavailable'));
    const { user } = setup();
    expect(await screen.findByText('Discussions are temporarily unavailable. Try again.')).toBeInTheDocument();
    answer(() => HttpResponse.json(page([postView(1)])));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('article', { name: 'Post 1' })).toBeInTheDocument();
  });
});
