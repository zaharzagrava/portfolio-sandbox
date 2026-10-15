import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemResponse } from '@/lib/test/msw-handlers';
import { BOARD_ID, ME, navigationMock, origin, page, postId, postView, renderWith, resetAddress } from '@/lib/test/discussions-fixtures';

vi.mock('next/navigation', () => navigationMock());

import { DiscussionComposer } from '@/components/product/discussions/discussion-composer';
import { DiscussionsPanel } from '@/components/product/discussions/discussions-panel';

const postUrl = `${origin}/api/boards/${BOARD_ID}/posts`;
type Sent = { key: string | null; csrf: string | null; body: unknown };
let sent: Sent[];

const accept = (handler: (n: number) => Response | Promise<Response> = () => HttpResponse.json(postView(1, { authorId: ME, title: 'Does it fit?' }), { status: 201 })) =>
  server.use(
    http.post(postUrl, async ({ request }) => {
      sent.push({ key: request.headers.get('idempotency-key'), csrf: request.headers.get('x-csrf-token'), body: await request.json() });
      return handler(sent.length);
    }),
  );

let consoleSpies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  sent = [];
  resetAddress();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
});
afterEach(() => vi.restoreAllMocks());

function setup(onPosted = vi.fn()) {
  return { onPosted, ...renderWith(<DiscussionComposer productId={BOARD_ID} onPosted={onPosted} onCancel={vi.fn()} />) };
}
const titleField = () => screen.getByRole('textbox', { name: 'Title' });
const detailsField = () => screen.getByRole('textbox', { name: 'Details (optional)' });
const postButton = () => screen.getByRole('button', { name: 'Post' });

describe('DiscussionComposer', () => {
  it('W02 AS-46: shows Title, Details (optional) and the markdown hint; Post waits for a title of 3 characters', async () => {
    const { user } = setup();
    expect(screen.getByText('Markdown supported: bold, italic, links, lists, quotes and code.')).toBeInTheDocument();
    expect(postButton()).toBeDisabled();
    await user.type(titleField(), 'ab');
    expect(postButton()).toBeDisabled();
    await user.type(titleField(), 'c');
    expect(postButton()).toBeEnabled();
    await user.clear(titleField());
    await user.type(titleField(), '   ');
    expect(postButton()).toBeDisabled();
  });

  it('W02 AS-46: counters appear within 200 characters of a limit, count code points, and over-limit text cannot be posted', async () => {
    const { user } = setup();
    expect(screen.queryByText(/\/ 300/)).toBeNull();
    await user.click(titleField());
    await user.paste('x'.repeat(100));
    expect(screen.getByText('100 / 300')).toBeInTheDocument();
    await user.clear(titleField());
    await user.paste('😀'.repeat(101));
    expect(screen.getByText('101 / 300')).toBeInTheDocument();
    await user.clear(titleField());
    await user.paste('y'.repeat(301));
    expect(screen.getByText('301 / 300')).toBeInTheDocument();
    expect(postButton()).toBeDisabled();
    await user.clear(titleField());
    await user.type(titleField(), 'Fine title');
    await user.click(detailsField());
    await user.paste('z'.repeat(39_900));
    expect(screen.getByText('39900 / 40000')).toBeInTheDocument();
    await user.paste('z'.repeat(101));
    expect(postButton()).toBeDisabled();
  });

  it('W02 AS-46: Post sends the trimmed title, the details, one Idempotency-Key and the CSRF header, then reports the post', async () => {
    accept();
    const { user, onPosted } = setup();
    await user.type(titleField(), '  Does it fit?  ');
    await user.type(detailsField(), 'Planning to use it with a **laptop**.');
    await user.click(postButton());
    await waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ title: 'Does it fit?', body: 'Planning to use it with a **laptop**.' });
    expect(sent[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[0]!.csrf).toBe('tok');
    expect(onPosted.mock.calls[0]![0]).toMatchObject({ postId: postId(1) });
  });

  it('W02 AS-46: empty details are not sent', async () => {
    accept();
    const { user, onPosted } = setup();
    await user.type(titleField(), 'Just a title');
    await user.click(postButton());
    await waitFor(() => expect(onPosted).toHaveBeenCalled());
    expect(sent[0]!.body).toEqual({ title: 'Just a title' });
  });

  it('W02 AS-46: Post is disabled while the request runs and a double click posts once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    accept(async () => {
      await gate;
      return HttpResponse.json(postView(1), { status: 201 });
    });
    const { user, onPosted } = setup();
    await user.type(titleField(), 'Double press');
    await user.dblClick(postButton());
    await waitFor(() => expect(postButton()).toBeDisabled());
    expect(sent).toHaveLength(1);
    release();
    await waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
    expect(sent).toHaveLength(1);
  });

  it('W02 AS-46: the Idempotency-Key is kept when the same attempt is retried and replaced after an edit', async () => {
    accept((n) => (n < 3 ? problemResponse(503, 'service_unavailable') : HttpResponse.json(postView(1), { status: 201 })));
    const { user } = setup();
    await user.type(titleField(), 'Retry me');
    await user.click(postButton());
    await screen.findByText('Discussions are temporarily unavailable. Try again.');
    await user.click(postButton());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.key).toBe(sent[0]!.key);
    await screen.findAllByText('Discussions are temporarily unavailable. Try again.');
    await user.type(titleField(), '!');
    await user.click(postButton());
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]!.key).not.toBe(sent[0]!.key);
  });

  it('W02 AS-46: after a success the next post gets a new key', async () => {
    accept();
    const first = setup();
    await first.user.type(titleField(), 'First one');
    await first.user.click(postButton());
    await waitFor(() => expect(first.onPosted).toHaveBeenCalled());
    // The same form posting again (the panel normally closes it) must not reuse the completed key.
    await first.user.type(titleField(), ' again');
    await first.user.click(postButton());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
  });

  it('W02 AS-46: field errors of 400 validation_failed appear under Title or Details and nothing is cleared', async () => {
    accept(() => problemResponse(400, 'validation_failed', { errors: [{ field: 'title', code: 'too_short' }, { field: 'body', code: 'too_long' }] }));
    const { user } = setup();
    await user.type(titleField(), 'Bad title');
    await user.type(detailsField(), 'Some details');
    await user.click(postButton());
    const titleError = await screen.findByText('Title must be 3 to 300 characters.');
    expect(titleField()).toHaveAttribute('aria-invalid', 'true');
    expect(titleField()).toHaveAccessibleDescription(expect.stringContaining('Title must be 3 to 300 characters.'));
    expect(titleError).toBeInTheDocument();
    expect(screen.getByText('Details can be at most 40,000 characters.')).toBeInTheDocument();
    expect(titleField()).toHaveValue('Bad title');
    expect(detailsField()).toHaveValue('Some details');
  });

  it('W02 AS-52: board_closed and rate limits are shown beside Post with the catalogue text and keep the text', async () => {
    accept((n) => (n === 1 ? problemResponse(409, 'board_closed') : problemResponse(429, 'rate_limited', { retryAfter: 30 })));
    const { user } = setup();
    await user.type(titleField(), 'Closed board');
    await user.click(postButton());
    expect(await screen.findByText('Discussions are closed for this product.')).toBeInTheDocument();
    await user.click(postButton());
    expect(await screen.findByText("You're posting too fast. Try again in 30 seconds.")).toBeInTheDocument();
    expect(titleField()).toHaveValue('Closed board');
  });

  it('W02 AS-74: a post made offline fails at once with the offline copy and keeps the text', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    accept();
    const { user } = setup();
    await user.type(titleField(), 'Offline title');
    await user.type(detailsField(), 'Offline details');
    await user.click(postButton());
    expect(await screen.findByText('You appear to be offline. Check your connection and try again.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    expect(titleField()).toHaveValue('Offline title');
    expect(detailsField()).toHaveValue('Offline details');
  });

  it('W02 AS-77: nothing the shopper typed reaches the console, also when the post fails', async () => {
    accept(() => problemResponse(500, 'internal_error'));
    const { user } = setup();
    await user.type(titleField(), 'Secret title text');
    await user.type(detailsField(), 'Secret details text');
    await user.click(postButton());
    await screen.findByText('Discussions are temporarily unavailable. Try again.');
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Secret/);
  });
});

describe('DiscussionsPanel posting', () => {
  it('W02 AS-46: after Post the form closes, the list switches to New with the new post first and focused, and a status says it was posted', async () => {
    const listed: URL[] = [];
    server.use(
      http.get(postUrl, ({ request }) => {
        const url = new URL(request.url);
        listed.push(url);
        return HttpResponse.json(
          url.searchParams.get('sort') === 'new' && sent.length > 0
            ? page([postView(5, { title: 'Does it fit?', authorId: ME }), postView(1)])
            : page([postView(1)]),
        );
      }),
    );
    accept(() => HttpResponse.json(postView(5, { title: 'Does it fit?', authorId: ME }), { status: 201 }));
    const { user } = renderWith(<DiscussionsPanel productId={BOARD_ID} />);
    await screen.findByRole('article', { name: 'Post 1' });
    await user.click(screen.getByRole('button', { name: 'Start a discussion' }));
    await user.type(titleField(), 'Does it fit?');
    await user.click(postButton());
    const created = await screen.findByRole('article', { name: 'Does it fit?' });
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(window.location.search).toBe('?tab=discussions&sort=new');
    expect(screen.getAllByRole('article')[0]).toBe(created);
    await waitFor(() => expect(created.querySelector('h3')).toHaveFocus());
    expect(screen.getByText('Your discussion was posted.').closest('[role="status"]')).not.toBeNull();
    expect(listed.at(-1)!.searchParams.get('sort')).toBe('new');
  });
});
