import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELLER_SHOP_ID, origin, sellerProblem, shopFixture } from '@/lib/test/seller-handlers';
import { server } from '../../../vitest.setup';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/dashboard/seller' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const refresh = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/hooks/use-auth-actions', () => ({ useRefreshSession: () => refresh }));

import { OpenShopForm } from './open-shop-form';

const USER_SESSION = { ok: true, kind: 'session', session: { user: { role: 'USER' } } };
const SELLER_SESSION = { ok: true, kind: 'session', session: { user: { role: 'SELLER' } } };

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OpenShopForm />
    </QueryClientProvider>,
  );
}

const nameInput = () => screen.getByLabelText('Shop name') as HTMLInputElement;
const handleInput = () => screen.getByLabelText('Handle') as HTMLInputElement;
const submitButton = () => screen.getByRole('button', { name: /Open shop|Opening…/ });

let posts: unknown[];
beforeEach(() => {
  posts = [];
  router.push.mockReset();
  toast.success.mockReset();
  refresh.mutateAsync.mockReset();
  refresh.mutateAsync.mockResolvedValue(USER_SESSION);
});
afterEach(() => vi.useRealTimers());

function answerWith(respond: () => Response | Promise<Response>) {
  server.use(
    http.post(`${origin}/api/shops`, async ({ request }) => {
      posts.push(await request.json());
      return respond();
    }),
  );
}

async function openWithFakeTimers() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  renderForm();
  await user.type(nameInput(), 'Clay Works');
  await user.click(submitButton());
  await waitFor(() => expect(router.push).toHaveBeenCalled());
}

describe('W04 open-shop form', () => {
  it('W04 AS-01: the form has the heading, the two fields and the button', () => {
    renderForm();
    expect(screen.getByRole('heading', { name: 'Open your shop' })).toBeInTheDocument();
    expect(nameInput()).toBeInTheDocument();
    expect(handleInput()).toBeInTheDocument();
    expect(submitButton()).toHaveTextContent('Open shop');
  });

  it('W04 AS-02: the handle follows the name until the member edits it', async () => {
    renderForm();
    await userEvent.type(nameInput(), 'Clay Works & Co');
    expect(handleInput()).toHaveValue('clay-works-co');
    await userEvent.clear(handleInput());
    await userEvent.type(handleInput(), 'my-clay');
    await userEvent.type(nameInput(), ' Two');
    expect(handleInput()).toHaveValue('my-clay');
  });

  it('W04 AS-02: a bad handle is reported when the field loses focus, never while typing', async () => {
    renderForm();
    await userEvent.type(nameInput(), 'Clay');
    await userEvent.type(handleInput(), 'AB');
    expect(screen.queryByText('Use 3 to 40 lowercase letters, digits or dashes.')).toBeNull();
    await userEvent.tab();
    expect(screen.getByText('Use 3 to 40 lowercase letters, digits or dashes.')).toBeInTheDocument();
    expect(handleInput()).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(handleInput(), 'c');
    expect(screen.queryByText('Use 3 to 40 lowercase letters, digits or dashes.')).toBeNull();
  });

  it('W04 AS-02: submitting with a bad handle shows the message and sends nothing', async () => {
    answerWith(() => HttpResponse.json(shopFixture(), { status: 201 }));
    renderForm();
    await userEvent.type(nameInput(), 'Clay Works');
    await userEvent.clear(handleInput());
    await userEvent.type(handleInput(), '-x');
    await userEvent.click(submitButton());
    expect(screen.getByText('Use 3 to 40 lowercase letters, digits or dashes.')).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it('W04 AS-03: opening the shop sends the trimmed name and handle, announces it once and goes to the overview', async () => {
    answerWith(() => HttpResponse.json(shopFixture(), { status: 201 }));
    renderForm();
    await userEvent.type(nameInput(), '  Clay Works ');
    await userEvent.click(submitButton());
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}`));
    expect(posts).toEqual([{ name: 'Clay Works', slug: 'clay-works' }]);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Your shop is open');
  });

  it('W04 AS-03: while the request runs the button reads "Opening…" and is disabled', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerWith(async () => {
      await gate;
      return HttpResponse.json(shopFixture(), { status: 201 });
    });
    renderForm();
    await userEvent.type(nameInput(), 'Clay Works');
    await userEvent.click(submitButton());
    await waitFor(() => expect(submitButton()).toHaveTextContent('Opening…'));
    expect(submitButton()).toBeDisabled();
    release();
    await waitFor(() => expect(router.push).toHaveBeenCalled());
  });

  it('W04 AS-04: the session is refreshed after 1 s, 2 s and 4 s, at most 3 times, without any message', async () => {
    answerWith(() => HttpResponse.json(shopFixture(), { status: 201 }));
    await openWithFakeTimers();
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(refresh.mutateAsync).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(400)); // 1.2 s: the first
    expect(refresh.mutateAsync).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1500)); // 2.7 s: the second is due at about 3 s
    expect(refresh.mutateAsync).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(700)); // 3.4 s
    expect(refresh.mutateAsync).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(3000)); // 6.4 s: the third is due at about 7 s
    expect(refresh.mutateAsync).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(refresh.mutateAsync).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(refresh.mutateAsync).toHaveBeenCalledTimes(3);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('W04 AS-04: it stops asking once the session shows the SELLER role', async () => {
    refresh.mutateAsync.mockResolvedValue(SELLER_SESSION);
    answerWith(() => HttpResponse.json(shopFixture(), { status: 201 }));
    await openWithFakeTimers();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(refresh.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['slug_taken', 'That handle is taken. Try another.'],
    ['slug_reserved', 'That handle is reserved. Try another.'],
  ] as const)('W04 AS-05: %s shows under "Handle", marks it invalid, focuses it and keeps the values', async (code, text) => {
    answerWith(() => sellerProblem(code));
    renderForm();
    await userEvent.type(nameInput(), 'Clay Works');
    await userEvent.click(submitButton());
    expect(await screen.findByText(text)).toBeInTheDocument();
    await waitFor(() => expect(handleInput()).toHaveFocus());
    expect(handleInput()).toHaveAttribute('aria-invalid', 'true');
    expect(nameInput()).toHaveValue('Clay Works');
    expect(handleInput()).toHaveValue('clay-works');
    expect(screen.queryByText('Server title that the UI must never show')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('W04 AS-05: validation errors[] land under the named fields and the first one gets focus', async () => {
    answerWith(() =>
      sellerProblem('validation_failed', { errors: [{ field: 'name', code: 'too_short' }, { field: 'slug', code: 'invalid' }] }),
    );
    renderForm();
    await userEvent.type(nameInput(), 'Clay Works');
    await userEvent.click(submitButton());
    await waitFor(() => expect(nameInput()).toHaveAttribute('aria-invalid', 'true'));
    expect(handleInput()).toHaveAttribute('aria-invalid', 'true');
    expect(nameInput()).toHaveFocus();
    expect(nameInput()).toHaveAccessibleDescription(/\S/);
  });

  it('W04 AS-06: shop_limit_reached shows an alert above the button', async () => {
    answerWith(() => sellerProblem('shop_limit_reached'));
    renderForm();
    await userEvent.type(nameInput(), 'Clay Works');
    await userEvent.click(submitButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You already own 10 shops.');
    expect(alert.compareDocumentPosition(submitButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(submitButton()).toBeEnabled();
  });

  it('W04 AS-06: 429 shows the countdown, disables the button, and re-enables it when the countdown ends', async () => {
    answerWith(() => sellerProblem('rate_limited', { retryAfter: 2 }));
    renderForm();
    await userEvent.type(nameInput(), 'Clay Works');
    await userEvent.click(submitButton());
    expect(await screen.findByText('Too many attempts. Try again in 2 s.')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    await waitFor(() => expect(submitButton()).toBeEnabled(), { timeout: 4000 });
  });

  it('W04 AS-06: a 5xx shows the generic message with its reference', async () => {
    answerWith(() => sellerProblem('service_unavailable', { requestId: 'req-open-1' }));
    renderForm();
    await userEvent.type(nameInput(), 'Clay Works');
    await userEvent.click(submitButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('req-open-1');
    expect(alert).not.toHaveTextContent('Server detail');
  });

  it('W04 AS-07: two quick presses and Enter while the request runs send exactly one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerWith(async () => {
      await gate;
      return HttpResponse.json(shopFixture(), { status: 201 });
    });
    renderForm();
    await userEvent.type(nameInput(), 'Clay Works');
    const button = submitButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(button.closest('form')!);
    await userEvent.type(nameInput(), '{Enter}');
    release();
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(posts).toHaveLength(1);
  });
});
