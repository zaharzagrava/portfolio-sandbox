import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthCard } from '@/components/auth/auth-card';
import { server } from '../../../../vitest.setup';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/auth/session-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session-sync')>()),
  announceAuth: vi.fn(),
  subscribeAuth: vi.fn(() => () => undefined),
}));

import { MfaForm } from './mfa-form';

const origin = 'http://localhost:3000';
const session = { user: { id: 'u1', email: 'a@b.co', role: 'USER' }, expiresAt: '2026-01-02T00:00:00.000Z' };

const code = () => screen.getByLabelText('Authentication code', { selector: 'input' });
const recovery = () => screen.getByLabelText('Recovery code', { selector: 'input' });
const verify = () => screen.getByRole('button', { name: 'Verify' });

function mount(returnTo?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthCard title="Two-step verification">
        <MfaForm returnTo={returnTo} />
      </AuthCard>
    </QueryClientProvider>,
  );
}

function stub(respond: () => Response) {
  const bodies: unknown[] = [];
  server.use(
    http.post(`${origin}/api/bff/session/mfa`, async ({ request }) => {
      bodies.push(await request.json());
      return respond();
    }),
    http.post(`${origin}/api/cart/merge`, () => HttpResponse.json({})),
  );
  return bodies;
}
const fail = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => () => HttpResponse.json(body, { status, headers });

describe('MfaForm', () => {
  beforeEach(() => {
    Object.values(router).forEach((fn) => fn.mockClear());
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('W01 AS-32: posts the code and applies the sign-in effects', async () => {
    const user = userEvent.setup();
    const bodies = stub(() => HttpResponse.json(session));
    mount('/account/security');
    await user.type(code(), '123456');
    await user.click(verify());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/account/security'));
    expect(bodies).toEqual([{ code: '123456' }]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(router.replace.mock.calls[0][0]).not.toContain('123456');
  });

  it('W01 AS-32: without returnTo the destination is / and an unsafe returnTo is replaced', async () => {
    const user = userEvent.setup();
    stub(() => HttpResponse.json(session));
    mount('//evil.example');
    await user.type(code(), '123456');
    await user.click(verify());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
  });

  it.each(['abcde-12345', 'ABCDE12345', ' abcde 12345 ', 'AbCdE-12345'])(
    'W01 AS-33: switches to recovery mode and posts %j as ABCDE-12345',
    async (typed) => {
      const user = userEvent.setup();
      const bodies = stub(() => HttpResponse.json(session));
      mount();
      await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
      expect(recovery()).toHaveAccessibleDescription('Format: XXXXX-XXXXX');
      expect(screen.queryByLabelText('Authentication code')).toBeNull();
      await user.type(recovery(), typed);
      await user.click(verify());
      await waitFor(() => expect(router.replace).toHaveBeenCalled());
      expect(bodies).toEqual([{ code: 'ABCDE-12345' }]);
    },
  );

  it('W01 AS-33: switches back to the authenticator code with an empty field', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(recovery(), 'abcde');
    await user.click(screen.getByRole('button', { name: 'Use authenticator code instead' }));
    expect(code()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Use a recovery code instead' })).toBeInTheDocument();
  });

  it.each([
    ['invalid_mfa_code', 401],
    ['invalid_code', 422],
  ])('W01 AS-34: %s shows the same alert, clears and focuses the field', async (errorCode, status) => {
    const user = userEvent.setup();
    stub(fail(status, { code: errorCode, detail: 'raw words' }));
    mount();
    await user.type(code(), '000000');
    await user.click(verify());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That code isn't right. Check your authenticator app and try again.");
    expect(document.body).not.toHaveTextContent('raw words');
    expect(code()).toHaveValue('');
    expect(code()).toHaveFocus();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['mfa_not_pending', 409],
    ['invalid_mfa_challenge', 401],
    ['invalid_token', 401],
  ])('W01 AS-35: %s replaces the form with the timed-out message and a Back to sign in link carrying returnTo', async (errorCode, status) => {
    const user = userEvent.setup();
    stub(fail(status, { code: errorCode }));
    mount('/account/security');
    await user.type(code(), '123456');
    await user.click(verify());
    expect(await screen.findByRole('alert')).toHaveTextContent('Your sign-in timed out. Sign in again.');
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login?returnTo=%2Faccount%2Fsecurity');
  });

  it('W01 AS-35: Back to sign in is the plain /login without a returnTo', async () => {
    const user = userEvent.setup();
    stub(fail(409, { code: 'mfa_not_pending' }));
    mount();
    await user.type(code(), '123456');
    await user.click(verify());
    expect(await screen.findByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('W01 AS-36: 429 disables Verify for Retry-After and re-enables it afterwards', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    stub(fail(429, { code: 'rate_limited' }, { 'Retry-After': '20' }));
    mount();
    await user.type(code(), '123456');
    await user.click(verify());
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many incorrect codes. Try again in 20 seconds.');
    await user.type(code(), '123456');
    expect(verify()).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(21_000);
    });
    expect(verify()).toBeEnabled();
  });

  it('W01 AS-10: a 500 shows the catalogue copy with the Reference id and keeps the form', async () => {
    const user = userEvent.setup();
    stub(fail(500, { requestId: 'req-5' }));
    mount();
    await user.type(code(), '123456');
    await user.click(verify());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side. Try again.');
    expect(alert).toHaveTextContent('Reference: req-5');
    expect(code()).toHaveValue('123456');
  });

  it('W01 AS-37: Verify stays disabled until six digits and the sixth digit submits nothing', async () => {
    const user = userEvent.setup();
    const bodies = stub(() => HttpResponse.json(session));
    mount();
    await user.type(code(), '12345');
    expect(verify()).toBeDisabled();
    await user.type(code(), '6');
    expect(verify()).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bodies).toHaveLength(0);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(bodies).toHaveLength(1));
  });

  it('W01 AS-12: sends one request on a double submit', async () => {
    const user = userEvent.setup();
    const bodies = stub(() => HttpResponse.json(session));
    mount();
    await user.type(code(), '123456');
    await user.click(verify());
    await user.keyboard('{Enter}{Enter}');
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(bodies).toHaveLength(1);
  });

  it('W01 AS-38: has one h1, nothing focused on load, and the expected tab order', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.body).toHaveFocus();
    await user.type(code(), '123456');
    code().blur();
    const order = [code(), verify(), screen.getByRole('button', { name: 'Use a recovery code instead' }), screen.getByRole('link', { name: 'Back to sign in' })];
    for (const element of order) {
      await user.tab();
      expect(element).toHaveFocus();
    }
  });

  it('W01 AS-13: the challenge is never in the URL, the DOM or the posted body', async () => {
    const user = userEvent.setup();
    const bodies = stub(() => HttpResponse.json(session));
    mount('/orders');
    await user.type(code(), '123456');
    await user.click(verify());
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(JSON.stringify(bodies)).toBe('[{"code":"123456"}]');
    expect(window.location.href).not.toMatch(/token|challenge/i);
  });

  it('W01 AS-67: console spies receive no code or recovery code', async () => {
    const user = userEvent.setup();
    const spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    stub(fail(401, { code: 'invalid_mfa_code' }));
    mount();
    await user.type(code(), '654321');
    await user.click(verify());
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(recovery(), 'zzzzz-99999');
    await user.click(verify());
    await waitFor(() => expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(false));
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain('654321');
    expect(logged).not.toMatch(/zzzzz/i);
  });
});
