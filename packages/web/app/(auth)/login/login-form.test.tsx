import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthCard } from '@/components/auth/auth-card';
import { server } from '../../../vitest.setup';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/auth/session-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session-sync')>()),
  announceAuth: vi.fn(),
  subscribeAuth: vi.fn(() => () => undefined),
}));

import { LoginForm } from './login-form';

const origin = 'http://localhost:3000';
const PASSWORD = 'hunter2-hunter2';
const session = { user: { id: 'u1', email: 'a@b.co', role: 'USER' }, expiresAt: '2026-01-02T00:00:00.000Z' };

const email = () => screen.getByLabelText('Email', { selector: 'input' });
const password = () => screen.getByLabelText('Password', { selector: 'input' });
const submit = () => screen.getByRole('button', { name: 'Sign in' });

function mount(props: Partial<{ returnTo: string; oidcEnabled: boolean }> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthCard title="Sign in">
        <LoginForm oidcEnabled={false} {...props} />
      </AuthCard>
    </QueryClientProvider>,
  );
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(email(), 'a@b.co');
  await user.type(password(), PASSWORD);
}

const login = (respond: () => Response | Promise<Response>) => server.use(http.post(`${origin}/api/bff/session`, respond));
const problem = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => () => HttpResponse.json(body, { status, headers });

describe('LoginForm', () => {
  beforeEach(() => {
    Object.values(router).forEach((fn) => fn.mockClear());
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('W01 AS-06: announces Signing in… and disables the button while pending, then follows returnTo', async () => {
    const user = userEvent.setup();
    login(async () => {
      await delay(150);
      return HttpResponse.json(session);
    });
    server.use(http.post(`${origin}/api/cart/merge`, () => HttpResponse.json({})));
    mount({ returnTo: '/account/security' });
    await fill(user);
    await user.click(submit());
    expect(screen.getByText('Signing in…')).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/account/security'));
  });

  it('W01 AS-08: blocks an empty submission without a request and focuses the first empty field', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(submit());
    expect(email()).toHaveFocus();
    expect(email()).toHaveAttribute('aria-invalid', 'true');
    expect(email()).toHaveAccessibleDescription('Enter your email address.');
    await user.type(email(), 'a@b.co');
    await user.click(submit());
    expect(password()).toHaveFocus();
    expect(password()).toHaveAttribute('aria-invalid', 'true');
    expect(password()).toHaveAccessibleDescription('Enter your password.');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('W01 AS-08: shows the credentials alert, clears and focuses the password and keeps the e-mail', async () => {
    const user = userEvent.setup();
    login(problem(401, { code: 'invalid_credentials', title: 'No such user', detail: 'user a@b.co not found' }));
    mount();
    await fill(user);
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The email or password is incorrect.');
    expect(document.body).not.toHaveTextContent('No such user');
    expect(document.body).not.toHaveTextContent('not found');
    expect(password()).toHaveValue('');
    expect(password()).toHaveFocus();
    expect(email()).toHaveValue('a@b.co');
    expect(submit()).toBeEnabled();
  });

  it('W01 AS-09: Retry-After disables Sign in and re-enables it when the time has passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    login(problem(429, { code: 'rate_limited' }, { 'Retry-After': '30' }));
    mount();
    await fill(user);
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sign-in attempts. Try again in 30 seconds.');
    expect(submit()).toBeDisabled();
    expect(email()).toHaveValue('a@b.co');
    expect(password()).toHaveValue(PASSWORD);
    await act(async () => {
      vi.advanceTimersByTime(29_000);
    });
    expect(submit()).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(submit()).toBeEnabled();
  });

  it.each([
    ['503', problem(503, { code: 'overloaded' }), 'This is taking longer than expected. Try again in a moment.', false],
    ['500', problem(500, { requestId: 'req-77' }), 'Something went wrong on our side. Try again.', true],
    ['network failure', () => HttpResponse.error(), 'You appear to be offline. Check your connection and try again.', false],
  ])('W01 AS-10: %s shows the catalogue copy, keeps the values and the button enabled', async (_name, respond, copy, reference) => {
    const user = userEvent.setup();
    login(respond);
    mount();
    await fill(user);
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy);
    if (reference) expect(alert).toHaveTextContent('Reference: req-77');
    else expect(alert).not.toHaveTextContent('Reference');
    expect(alert).toHaveFocus();
    expect(email()).toHaveValue('a@b.co');
    expect(password()).toHaveValue(PASSWORD);
    expect(submit()).toBeEnabled();
  });

  it.each(['csrf_invalid', 'origin_not_allowed'])('W01 AS-11: %s shows the verify alert with a Reload button', async (code) => {
    const user = userEvent.setup();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    login(problem(403, { code }));
    mount();
    await fill(user);
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't verify this request. Reload the page and try again.");
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('W01 AS-12: sends one request when submitted twice and makes the fields read-only while pending', async () => {
    const user = userEvent.setup();
    let count = 0;
    login(async () => {
      count++;
      await delay(150);
      return HttpResponse.json(session);
    });
    server.use(http.post(`${origin}/api/cart/merge`, () => HttpResponse.json({})));
    mount();
    await fill(user);
    await user.click(submit());
    await user.click(submit());
    await user.type(password(), '{Enter}');
    expect(email()).toHaveAttribute('readonly');
    expect(password()).toHaveAttribute('readonly');
    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(count).toBe(1);
  });

  it('W01 AS-13: navigates to /login/mfa?returnTo with history replaced and nothing else in the URL', async () => {
    const user = userEvent.setup();
    login(() => HttpResponse.json({ mfaRequired: true }));
    mount({ returnTo: '/account/security?tab=methods' });
    await fill(user);
    await user.click(submit());
    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(router.replace).toHaveBeenCalledWith('/login/mfa?returnTo=%2Faccount%2Fsecurity%3Ftab%3Dmethods');
    expect(router.push).not.toHaveBeenCalled();
    const url = router.replace.mock.calls[0][0] as string;
    expect(url).not.toContain(PASSWORD);
    expect(url).not.toContain('a@b.co');
    expect(url).not.toContain('token');
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('W01 AS-13: without a returnTo the hand-off is the plain second-step page', async () => {
    const user = userEvent.setup();
    login(() => HttpResponse.json({ mfaRequired: true }));
    mount();
    await fill(user);
    await user.click(submit());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login/mfa'));
  });

  it('W01 AS-14: has no Remember me or GitHub, labelled fields, and the expected tab order', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText(/remember me/i)).toBeNull();
    expect(screen.queryByText(/github/i)).toBeNull();
    expect(email()).toHaveAttribute('autocomplete', 'username');
    expect(email()).toHaveAttribute('type', 'email');
    expect(password()).toHaveAttribute('autocomplete', 'current-password');
    expect(document.body).toHaveFocus();
    const order = [
      email(),
      password(),
      screen.getByRole('button', { name: 'Show password' }),
      screen.getByRole('link', { name: 'Forgot password?' }),
      submit(),
      screen.getByRole('link', { name: 'Register' }),
    ];
    for (const element of order) {
      await user.tab();
      expect(element).toHaveFocus();
    }
  });

  describe('Continue with Google', () => {
    const providers = (list: unknown[], counter?: { n: number }) =>
      server.use(
        http.get(`${origin}/api/auth/oidc/providers`, () => {
          if (counter) counter.n++;
          return HttpResponse.json(list);
        }),
      );

    it('W01 AS-58: renders Continue with Google only when enabled and the provider is offered', async () => {
      providers([{ id: 'google', displayName: 'Google' }]);
      mount({ oidcEnabled: true });
      expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    });

    it('W01 AS-58: makes no OIDC request and renders nothing when the flag is off', async () => {
      const counter = { n: 0 };
      providers([{ id: 'google', displayName: 'Google' }], counter);
      mount({ oidcEnabled: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
      expect(counter.n).toBe(0);
    });

    it.each([
      ['an empty list', () => HttpResponse.json([])],
      ['another provider only', () => HttpResponse.json([{ id: 'github', displayName: 'GitHub' }])],
      ['a failing request', () => HttpResponse.json({ code: 'overloaded' }, { status: 503 })],
    ])('W01 AS-58: renders nothing for %s and leaves the form intact', async (_name, respond) => {
      server.use(http.get(`${origin}/api/auth/oidc/providers`, respond));
      mount({ oidcEnabled: true });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
      expect(submit()).toBeEnabled();
    });

    it('W01 AS-58: start calls the start route with the validated returnTo, then navigates to authorizationUrl', async () => {
      const user = userEvent.setup();
      const assign = vi.fn();
      vi.stubGlobal('location', { ...window.location, assign });
      providers([{ id: 'google', displayName: 'Google' }]);
      let body: unknown;
      server.use(
        http.post(`${origin}/api/auth/oidc/google/start`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ authorizationUrl: 'https://accounts.example/o/oauth2/auth?x=1' });
        }),
      );
      mount({ oidcEnabled: true, returnTo: '/orders' });
      await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.example/o/oauth2/auth?x=1'));
      expect(body).toEqual({ returnTo: '/orders' });
    });

    it('W01 AS-58: a start failure shows the AS-10 copy and re-enables the button', async () => {
      const user = userEvent.setup();
      providers([{ id: 'google', displayName: 'Google' }]);
      server.use(http.post(`${origin}/api/auth/oidc/google/start`, problem(503, { code: 'oidc_provider_unavailable' })));
      mount({ oidcEnabled: true });
      await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('This is taking longer than expected. Try again in a moment.');
      expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    });

    it('W01 AS-14: Continue with Google sits between Sign in and the Register link in the tab order', async () => {
      const user = userEvent.setup();
      providers([{ id: 'google', displayName: 'Google' }]);
      mount({ oidcEnabled: true });
      const google = await screen.findByRole('button', { name: 'Continue with Google' });
      submit().focus();
      await user.tab();
      expect(google).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('link', { name: 'Register' })).toHaveFocus();
    });
  });

  it('W01 AS-67: console spies receive no password, e-mail or body', async () => {
    const user = userEvent.setup();
    const spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    login(problem(401, { code: 'invalid_credentials' }));
    mount();
    await fill(user);
    await user.click(submit());
    await screen.findByRole('alert');
    login(() => HttpResponse.error());
    await user.type(password(), PASSWORD);
    await user.click(submit());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('offline'));
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('a@b.co');
  });
});
