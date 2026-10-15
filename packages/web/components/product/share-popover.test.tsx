import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionEndHandler, rearmSessionEnd } from '@/lib/auth/session-ended';
import { problemResponse } from '@/lib/test/msw-handlers';
import { renderWith } from '@/lib/test/discussions-fixtures';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { server } from '@/vitest.setup';
import { SharePopover } from './share-popover';

const PRODUCT = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const DESTINATION = `http://localhost:3000/products/${PRODUCT}`;
const URL = 'http://localhost:3000/api/links';
const SHORT = 'https://mkt.to/aB3dE9x';

const link = (shortUrl = SHORT) => ({
  code: 'aB3dE9x',
  shortUrl,
  destination: DESTINATION,
  status: 'ACTIVE',
  kind: 'generated',
  createdAt: '2026-10-14T09:00:00.000Z',
  updatedAt: '2026-10-14T09:00:00.000Z',
  expiresAt: null,
});
const created = (shortUrl?: string) => HttpResponse.json(link(shortUrl), { status: 201, headers: { Location: '/api/links/aB3dE9x' } });

type Seen = { key: string | null; body: unknown };
let seen: Seen[];
const answer = (...responses: (() => Response)[]) => {
  let n = 0;
  server.use(
    http.post(URL, async ({ request }) => {
      seen.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
      const respond = responses[Math.min(n, responses.length - 1)]!;
      n += 1;
      return respond();
    }),
  );
};

const ui = <SharePopover productId={PRODUCT} destination={DESTINATION} />;
const shareButton = () => screen.getByRole('button', { name: 'Share' });
const dialog = () => screen.findByRole('dialog', { name: 'Share this product' });

beforeEach(() => {
  seen = [];
  rearmSessionEnd();
  setSessionEndHandler(null);
  window.history.replaceState(null, '', `/products/${PRODUCT}?tab=ask`);
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SharePopover', () => {
  it('W02 AS-60: creating state, then one request with an Idempotency-Key and the product address, then the link and Copy link', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(URL, async ({ request }) => {
        seen.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
        await gate;
        return created();
      }),
    );
    const { user } = renderWith(ui);
    await user.click(shareButton());
    const box = await dialog();
    expect(within(box).getByText('Creating your link…')).toBeInTheDocument();
    release();
    const field = await within(box).findByRole('textbox', { name: 'Share link' });
    expect(field).toHaveValue(SHORT);
    expect(field).toHaveAttribute('readonly');
    await waitFor(() => expect(field).toHaveFocus());
    expect(within(box).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toEqual({ destination: DESTINATION });
    expect(seen[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('W02 AS-60: closing and reopening during the same page visit shows the same link without a new request', async () => {
    answer(() => created());
    const { user } = renderWith(ui);
    await user.click(shareButton());
    await screen.findByRole('textbox', { name: 'Share link' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(shareButton());
    expect(await screen.findByRole('textbox', { name: 'Share link' })).toHaveValue(SHORT);
    expect(seen).toHaveLength(1);
  });

  it('W02 AS-60: Escape closes the popover and focus returns to Share', async () => {
    answer(() => created());
    const { user } = renderWith(ui);
    await user.click(shareButton());
    await screen.findByRole('textbox', { name: 'Share link' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(shareButton()).toHaveFocus();
  });

  it('W02 AS-60: Copy link writes the address to the clipboard and says "Link copied." in a polite status', async () => {
    answer(() => created());
    const { user } = renderWith(ui);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(shareButton());
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(SHORT);
    const status = await screen.findByText('Link copied.');
    expect(status.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
  });

  it('W02 AS-60: without a clipboard the text is selected and "Press Ctrl+C to copy." is shown', async () => {
    answer(() => created());
    const { user } = renderWith(ui);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await user.click(shareButton());
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('Press Ctrl+C to copy.')).toBeInTheDocument();
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Share link' });
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, SHORT.length]);
    expect(screen.queryByText('Link copied.')).toBeNull();
  });

  it('W02 AS-61: a visitor who is not signed in sees the prompt with a Sign in link and returnTo, and no request is made', async () => {
    answer(() => created());
    const { user } = renderWith(ui, null);
    await user.click(shareButton());
    const box = await dialog();
    expect(within(box).getByText('Sign in to create a share link.')).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent(`/products/${PRODUCT}?tab=ask`)}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toEqual([]);
  });

  it('W02 AS-61: Share is disabled while the session loads', async () => {
    let asked = false;
    server.use(
      http.get('http://localhost:3000/api/bff/session', () => {
        asked = true;
        return new Promise<Response>(() => {});
      }),
    );
    const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    const view = render(
      <QueryClientProvider client={client}>
        <SharePopover productId={PRODUCT} destination={DESTINATION} />
      </QueryClientProvider>,
    );
    expect(shareButton()).toBeDisabled();
    await waitFor(() => expect(asked).toBe(true));
    view.unmount();
    client.clear();
  });

  it('W02 AS-72: a shortUrl that is not https is ignored and the failure form is shown', async () => {
    answer(() => created('http://mkt.to/aB3dE9x'));
    const { user } = renderWith(ui);
    await user.click(shareButton());
    const box = await dialog();
    expect(await within(box).findByRole('alert')).toHaveTextContent('Sharing is temporarily unavailable. Try again.');
    expect(within(box).queryByRole('textbox')).toBeNull();
    expect(box.textContent).not.toContain('http://mkt.to');
  });

  it.each([
    ['link_limit_reached', 422, "You've reached the limit of share links."],
    ['destination_not_allowed', 422, "This product can't be shared right now."],
    ['destination_blocked', 422, "This product can't be shared right now."],
    ['idempotency_key_reuse', 422, "This product can't be shared right now."],
    ['validation_failed', 400, "This product can't be shared right now."],
  ])('W02 AS-62: %s (%i) shows its text and no Try again', async (code, status, text) => {
    answer(() => problemResponse(status, code));
    const { user } = renderWith(ui);
    await user.click(shareButton());
    const box = await dialog();
    expect(await within(box).findByRole('alert')).toHaveTextContent(text);
    expect(within(box).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(box.textContent).not.toContain('Server title');
  });

  it('W02 AS-62: 429 says how long to wait, and Try again re-sends with the same key and then shows the link', async () => {
    answer(() => problemResponse(429, 'rate_limited', { retryAfter: 30 }), () => created());
    const { user } = renderWith(ui);
    await user.click(shareButton());
    const box = await dialog();
    expect(await within(box).findByRole('alert')).toHaveTextContent('Too many share links created. Try again in 30 seconds.');
    await user.click(within(box).getByRole('button', { name: 'Try again' }));
    expect(await within(box).findByRole('textbox', { name: 'Share link' })).toHaveValue(SHORT);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.key).toBe(seen[0]!.key);
  });

  it('W02 AS-62: 503 shows the unavailable text with the reference and Try again', async () => {
    answer(() => problemResponse(503, 'service_unavailable', { requestId: 'req-7f3a' }));
    const { user } = renderWith(ui);
    await user.click(shareButton());
    const box = await dialog();
    const alert = await within(box).findByRole('alert');
    expect(alert).toHaveTextContent('Sharing is temporarily unavailable. Try again.');
    expect(alert).toHaveTextContent('Reference: req-7f3a');
    expect(within(box).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('W02 AS-62: 409 idempotency_in_flight keeps "Creating your link…" and repeats the request with the same key after one second', async () => {
    const inFlight = () => problemResponse(409, 'idempotency_in_flight');
    answer(inFlight, inFlight, () => created());
    const { user } = renderWith(ui);
    await user.click(shareButton());
    const box = await dialog();
    await within(box).findByText('Creating your link…');
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(within(box).queryByRole('alert')).toBeNull();
    expect(await within(box).findByRole('textbox', { name: 'Share link' }, { timeout: 4000 })).toHaveValue(SHORT);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((request) => request.key)).size).toBe(1);
  }, 10_000);

  it('W02 AS-62: 409 idempotency_in_flight is repeated at most three times, then the failure form is shown', async () => {
    answer(() => problemResponse(409, 'idempotency_in_flight'));
    const { user } = renderWith(ui);
    await user.click(shareButton());
    const box = await dialog();
    expect(await within(box).findByRole('alert', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(seen).toHaveLength(4);
    expect(new Set(seen.map((request) => request.key)).size).toBe(1);
  }, 12_000);

  it('W02 AS-62: 401 runs the session-ended flow of sign-in', async () => {
    const ended = vi.fn();
    setSessionEndHandler(ended);
    answer(() => problemResponse(401, 'unauthenticated'));
    const { user } = renderWith(ui);
    await user.click(shareButton());
    const box = await dialog();
    expect(await within(box).findByRole('alert')).toHaveTextContent('Your session ended. Sign in again to continue.');
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('W02 AS-62: with no network the offline text is shown and Try again works when it is back', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    answer(() => created());
    const { user } = renderWith(ui);
    await user.click(shareButton());
    const box = await dialog();
    expect(await within(box).findByRole('alert')).toHaveTextContent('You appear to be offline. Check your connection and try again.');
    expect(seen).toEqual([]);
    online.mockReturnValue(true);
    await user.click(within(box).getByRole('button', { name: 'Try again' }));
    expect(await within(box).findByRole('textbox', { name: 'Share link' })).toHaveValue(SHORT);
  });

  it('W02 AS-62: a connection failure shows the offline text', async () => {
    server.use(http.post(URL, () => HttpResponse.error()));
    const { user } = renderWith(ui);
    await user.click(shareButton());
    expect(await within(await dialog()).findByRole('alert')).toHaveTextContent('You appear to be offline.');
  });

  it('W02 AS-60: the link is a query result under the share key, not component state', async () => {
    answer(() => created());
    const { user, client } = renderWith(ui);
    await user.click(shareButton());
    await screen.findByRole('textbox', { name: 'Share link' });
    expect(client.getQueryData(['share', 'link', PRODUCT])).toMatchObject({ shortUrl: SHORT });
  });
});
