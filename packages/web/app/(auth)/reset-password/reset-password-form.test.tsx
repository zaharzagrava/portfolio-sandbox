import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthCard } from '@/components/auth/auth-card';
import { server } from '../../../vitest.setup';
import { ResetPasswordForm } from './reset-password-form';

const origin = 'http://localhost:3000';
const ENDPOINT = `${origin}/api/auth/password-reset/confirm`;
const NEW_PASSWORD = 'a brand new passphrase';

const first = () => screen.getByLabelText('New password', { selector: 'input' });
const second = () => screen.getByLabelText('Confirm new password', { selector: 'input' });
const update = () => screen.getByRole('button', { name: 'Update password' });

function mount() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AuthCard title="Reset password"><ResetPasswordForm /></AuthCard>
    </QueryClientProvider>,
  );
}

function stub(status: number, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const calls: unknown[] = [];
  server.use(
    http.post(ENDPOINT, async ({ request }) => {
      calls.push(await request.json());
      return status === 204 ? new HttpResponse(null, { status }) : HttpResponse.json(body, { status, headers });
    }),
  );
  return calls;
}

async function fill(user: ReturnType<typeof userEvent.setup>, password = NEW_PASSWORD, confirm = password) {
  await user.type(first(), password);
  await user.type(second(), confirm);
}

describe('ResetPasswordForm', () => {
  beforeEach(() => window.history.replaceState(null, '', '/reset-password#token=tok-123'));
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('W01 AS-41: reads and strips the fragment token with replaceState; submits {token, password}; success screen and Sign in link', async () => {
    const user = userEvent.setup();
    const replace = vi.spyOn(window.history, 'replaceState');
    const calls = stub(204);
    mount();
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.pathname).toBe('/reset-password');
    expect(replace).toHaveBeenCalled();
    await fill(user);
    await user.click(update());
    const heading = await screen.findByRole('heading', { name: 'Password updated' });
    expect(calls).toEqual([{ token: 'tok-123', password: NEW_PASSWORD }]);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?notice=password_reset');
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('W01 AS-42: no token makes no request and shows the invalid-link state', async () => {
    window.history.replaceState(null, '', '/reset-password');
    const calls = stub(204);
    mount();
    expect(await screen.findByText('This reset link is invalid or has expired.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password');
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('W01 AS-42: invalid_reset_token shows the same invalid-link state', async () => {
    const user = userEvent.setup();
    stub(400, { code: 'invalid_reset_token' });
    mount();
    await fill(user);
    await user.click(update());
    expect(await screen.findByText('This reset link is invalid or has expired.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password');
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it.each([
    ['weak_password', 422, { code: 'weak_password' }, {}, 'This password has appeared in a known data breach. Choose a different one.'],
    ['validation_failed', 400, { code: 'validation_failed', errors: [{ field: 'password', code: 'too_short' }] }, {}, 'Use 12 to 128 characters.'],
    ['429', 429, { code: 'rate_limited' }, { 'retry-after': '30' }, 'Too many attempts. Try again in 30 seconds.'],
  ])('W01 AS-43: %s keeps the form and the in-memory token', async (_name, status, body, headers, text) => {
    const user = userEvent.setup();
    const calls = stub(status, body, headers);
    mount();
    await fill(user);
    await user.click(update());
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(first()).toBeInTheDocument();
    await user.click(update());
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ token: 'tok-123', password: expect.any(String) });
  });

  it('W01 AS-43: client checks show first and send nothing', async () => {
    const user = userEvent.setup();
    const calls = stub(204);
    mount();
    await fill(user, 'short');
    await user.click(update());
    expect(await screen.findByText('Use 12 to 128 characters.')).toBeInTheDocument();
    expect(first()).toHaveFocus();
    await user.clear(first());
    await user.clear(second());
    await fill(user, NEW_PASSWORD, 'something else entirely');
    await user.click(update());
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('W01 AS-44: expected tab order', async () => {
    const user = userEvent.setup();
    mount();
    await user.tab();
    expect(first()).toHaveFocus();
    await user.tab();
    expect(screen.getAllByRole('button', { name: 'Show password' })[0]).toHaveFocus();
    await user.tab();
    expect(second()).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(update()).toHaveFocus();
  });
});
