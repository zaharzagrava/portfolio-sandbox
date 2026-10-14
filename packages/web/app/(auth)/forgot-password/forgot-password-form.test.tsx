import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthCard } from '@/components/auth/auth-card';
import { server } from '../../../vitest.setup';
import { ForgotPasswordForm } from './forgot-password-form';

const origin = 'http://localhost:3000';
const ENDPOINT = `${origin}/api/auth/password-reset/request`;

const mount = () => render(<AuthCard title="Forgot password"><ForgotPasswordForm /></AuthCard>);
const field = () => screen.getByLabelText('Email', { selector: 'input' });
const send = () => screen.getByRole('button', { name: 'Send reset link' });

function stub(status: number, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const calls: unknown[] = [];
  server.use(
    http.post(ENDPOINT, async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json(body, { status, headers });
    }),
  );
  return calls;
}

describe('ForgotPasswordForm', () => {
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-39: shows the confirmation only on 202; focus moves to the heading', async () => {
    const user = userEvent.setup();
    const calls = stub(202, { status: 'accepted' });
    mount();
    await user.type(field(), 'who@example.com');
    await user.click(send());
    const heading = await screen.findByRole('heading', { name: 'Check your inbox' });
    expect(calls).toEqual([{ email: 'who@example.com' }]);
    expect(
      screen.getByText(/If an account exists for that address, we've sent a link to reset the password\. The link works once and expires in 30 minutes\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it.each([
    ['429', 429, { code: 'rate_limited' }, { 'retry-after': '120' }, 'Too many reset requests. Try again in 2 minutes.'],
    ['400', 400, { code: 'validation_failed', errors: [{ field: 'email', code: 'invalid' }] }, {}, 'Enter a valid email address.'],
    ['500', 500, { code: 'internal_error' }, {}, 'Something went wrong on our side. Try again.'],
  ])('W01 AS-40: %s keeps the form and never shows the confirmation', async (_name, status, body, headers, text) => {
    const user = userEvent.setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stub(status, body, headers);
    mount();
    await user.type(field(), 'who@example.com');
    await user.click(send());
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Check your inbox' })).toBeNull();
    expect(field()).toHaveValue('who@example.com');
    expect(error).not.toHaveBeenCalled();
  });

  it('W01 AS-40: a network failure keeps the form with the offline message', async () => {
    const user = userEvent.setup();
    server.use(http.post(ENDPOINT, () => HttpResponse.error()));
    mount();
    await user.type(field(), 'who@example.com');
    await user.click(send());
    expect(await screen.findByText('You appear to be offline. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Check your inbox' })).toBeNull();
    expect(field()).toHaveValue('who@example.com');
  });

  it('W01 AS-40: a malformed address is refused on the client and sends nothing', async () => {
    const user = userEvent.setup();
    const calls = stub(202, { status: 'accepted' });
    mount();
    await user.type(field(), 'nope');
    await user.click(send());
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(calls).toEqual([]);
    expect(field()).toHaveFocus();
  });
});
