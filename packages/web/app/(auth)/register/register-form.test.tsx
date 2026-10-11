import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthCard } from '@/components/auth/auth-card';
import { server } from '../../../vitest.setup';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { RegisterForm } from './register-form';

const origin = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';

const email = () => screen.getByLabelText('Email', { selector: 'input' });
const password = () => screen.getByLabelText('Password', { selector: 'input' });
const confirm = () => screen.getByLabelText('Confirm password', { selector: 'input' });
const terms = () => screen.getByRole('checkbox', { name: /I agree to the Terms and Privacy Policy/ });
const submit = () => screen.getByRole('button', { name: 'Create account' });

const mount = () => render(<AuthCard title="Create account"><RegisterForm /></AuthCard>);

async function fill(user: ReturnType<typeof userEvent.setup>, over: Partial<{ email: string; password: string; confirm: string; terms: boolean }> = {}) {
  const values = { email: 'new@example.com', password: PASSWORD, confirm: PASSWORD, terms: true, ...over };
  if (values.email) await user.type(email(), values.email);
  if (values.password) await user.type(password(), values.password);
  if (values.confirm) await user.type(confirm(), values.confirm);
  if (values.terms) await user.click(terms());
}

function stubRegister(status = 202, body: unknown = { status: 'accepted' }) {
  const calls: unknown[] = [];
  server.use(
    http.post(`${origin}/api/auth/register`, async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json(body as Record<string, unknown>, { status });
    }),
  );
  return calls;
}

describe('RegisterForm', () => {
  beforeEach(() => Object.values(router).forEach((fn) => fn.mockClear()));
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-01: sends only email and password and navigates to the registered notice', async () => {
    const user = userEvent.setup();
    const calls = stubRegister();
    mount();
    await fill(user, { email: '  new@example.com  ' });
    await user.click(submit());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login?notice=registered'));
    expect(calls).toEqual([{ email: 'new@example.com', password: PASSWORD }]);
    expect(router.replace.mock.calls[0][0]).not.toContain(PASSWORD);
    expect(router.replace.mock.calls[0][0]).not.toContain('example.com');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('W01 AS-02: shows the same outcome for every 202 response', async () => {
    const outcomes: string[] = [];
    for (const address of ['first@example.com', 'existing@example.com']) {
      router.replace.mockClear();
      stubRegister();
      const user = userEvent.setup();
      const view = mount();
      await fill(user, { email: address });
      await user.click(submit());
      await waitFor(() => expect(router.replace).toHaveBeenCalled());
      outcomes.push(`${router.replace.mock.calls.map((c) => c[0]).join(',')}|alerts=${screen.queryAllByRole('alert').length}|${document.activeElement?.tagName}`);
      view.unmount();
    }
    expect(outcomes[0]).toBe(outcomes[1]);
  });

  describe('client validation', () => {
    const cases: [string, Parameters<typeof fill>[1], () => HTMLElement, string][] = [
      ['empty e-mail', { email: '' }, email, 'Enter a valid email address.'],
      ['malformed e-mail', { email: 'not-an-email' }, email, 'Enter a valid email address.'],
      ['11 character password', { password: 'a'.repeat(11), confirm: 'a'.repeat(11) }, password, 'Use 12 to 128 characters.'],
      ['129 character password', { password: 'a'.repeat(129), confirm: 'a'.repeat(129) }, password, 'Use 12 to 128 characters.'],
      ['different confirmation', { confirm: `${PASSWORD}!` }, confirm, "The passwords don't match."],
      ['terms unticked', { terms: false }, terms, 'Accept the terms to continue.'],
    ];
    it.each(cases)('W01 AS-03: blocks submission and names the problem for %s', async (_name, values, field, message) => {
      const user = userEvent.setup();
      const calls = stubRegister();
      mount();
      await fill(user, values);
      await user.click(submit());
      expect(calls).toHaveLength(0);
      expect(router.replace).not.toHaveBeenCalled();
      expect(field()).toHaveAttribute('aria-invalid', 'true');
      expect(field()).toHaveAccessibleDescription(expect.stringContaining(message));
      expect(field()).toHaveFocus();
    });

    it('W01 AS-03: focuses the first invalid field and marks every invalid field', async () => {
      const user = userEvent.setup();
      mount();
      await user.click(submit());
      expect(email()).toHaveFocus();
      for (const field of [email(), password(), terms()]) expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(email()).toHaveAccessibleDescription('Enter a valid email address.');
    });

    it('W01 AS-03: clears a field error once the visitor fixes the field and submits again', async () => {
      const user = userEvent.setup();
      stubRegister();
      mount();
      await fill(user, { email: 'bad' });
      await user.click(submit());
      expect(email()).toHaveAttribute('aria-invalid', 'true');
      await user.clear(email());
      await user.type(email(), 'ok@example.com');
      await user.click(submit());
      await waitFor(() => expect(router.replace).toHaveBeenCalled());
      expect(email()).not.toHaveAttribute('aria-invalid', 'true');
    });
  });

  it('W01 AS-04: places field errors from validation_failed under the matching fields', async () => {
    const user = userEvent.setup();
    stubRegister(400, {
      code: 'validation_failed',
      errors: [
        { field: 'email', code: 'invalid_email' },
        { field: 'password', code: 'too_short' },
      ],
      detail: 'raw server words',
    });
    mount();
    await fill(user);
    await user.click(submit());
    await waitFor(() => expect(email()).toHaveAttribute('aria-invalid', 'true'));
    expect(email()).toHaveAccessibleDescription('Enter a valid email address.');
    expect(password()).toHaveAttribute('aria-invalid', 'true');
    expect(password()).toHaveAccessibleDescription(expect.stringContaining('Use 12 to 128 characters.'));
    expect(email()).toHaveFocus();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body).not.toHaveTextContent('raw server words');
  });

  it('W01 AS-04: a field the form does not have goes to the form-level alert', async () => {
    const user = userEvent.setup();
    stubRegister(400, { code: 'validation_failed', errors: [{ field: 'role', code: 'forbidden' }] });
    mount();
    await fill(user);
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the highlighted fields.');
    expect(screen.getByRole('alert')).toHaveFocus();
  });

  it('W01 AS-04: weak_password clears both passwords, focuses Password and keeps the e-mail', async () => {
    const user = userEvent.setup();
    stubRegister(422, { code: 'weak_password' });
    mount();
    await fill(user);
    await user.click(submit());
    await waitFor(() => expect(password()).toHaveFocus());
    expect(password()).toHaveValue('');
    expect(confirm()).toHaveValue('');
    expect(email()).toHaveValue('new@example.com');
    expect(password()).toHaveAttribute('aria-invalid', 'true');
    expect(password()).toHaveAccessibleDescription(expect.stringContaining('This password has appeared in a known data breach. Choose a different one.'));
    expect(document.body).not.toHaveTextContent(PASSWORD);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['429 with Retry-After', () => HttpResponse.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '30' } }), 'Too many sign-up attempts. Try again in 30 seconds.'],
    ['503', () => HttpResponse.json({ code: 'overloaded' }, { status: 503 }), 'This is taking longer than expected. Try again in a moment.'],
    ['500 with request id', () => HttpResponse.json({ requestId: 'req-9' }, { status: 500 }), 'Something went wrong on our side. Try again.'],
    ['network failure', () => HttpResponse.error(), 'You appear to be offline. Check your connection and try again.'],
  ])('W01 AS-10: %s shows the catalogue copy, keeps the values and re-enables the button', async (_name, respond, copy) => {
    const user = userEvent.setup();
    server.use(http.post(`${origin}/api/auth/register`, respond));
    mount();
    await fill(user);
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy);
    expect(alert).toHaveFocus();
    expect(email()).toHaveValue('new@example.com');
    expect(submit()).toBeEnabled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('W01 AS-10: a 500 shows the Reference id', async () => {
    const user = userEvent.setup();
    stubRegister(500, { requestId: 'req-9' });
    mount();
    await fill(user);
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference: req-9');
  });

  it('W01 AS-12: announces Creating your account…, makes fields read-only and sends one request on double submit', async () => {
    const user = userEvent.setup();
    let count = 0;
    server.use(
      http.post(`${origin}/api/auth/register`, async () => {
        count++;
        await delay(150);
        return HttpResponse.json({ status: 'accepted' }, { status: 202 });
      }),
    );
    mount();
    await fill(user);
    await user.click(submit());
    await user.click(submit());
    await user.keyboard('{Enter}');
    expect(submit()).toHaveAttribute('aria-busy', 'true');
    expect(email()).toHaveAttribute('readonly');
    expect(password()).toHaveAttribute('readonly');
    expect(screen.getByText('Creating your account…')).toBeInTheDocument();
    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(count).toBe(1);
  });

  it('W01 AS-05: has no name or role field, one h1, labelled controls and the expected tab order', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByLabelText(/name/i)).toBeNull();
    expect(screen.queryByLabelText(/role/i)).toBeNull();
    expect(password()).toHaveAttribute('autocomplete', 'new-password');
    expect(confirm()).toHaveAttribute('autocomplete', 'new-password');
    expect(password()).toHaveAccessibleDescription('Use 12 to 128 characters.');
    const order = [
      email(),
      password(),
      screen.getAllByRole('button', { name: 'Show password' })[0],
      confirm(),
      screen.getAllByRole('button', { name: 'Show password' })[1],
      terms(),
      screen.getByRole('link', { name: 'Terms' }),
      screen.getByRole('link', { name: 'Privacy Policy' }),
      submit(),
      screen.getByRole('link', { name: 'Log in' }),
    ];
    for (const element of order) {
      await user.tab();
      expect(element).toHaveFocus();
    }
  });

  it('W01 AS-66: nothing is focused on load and required fields are marked in text', () => {
    mount();
    expect(document.body).toHaveFocus();
    expect(screen.getByText('All fields are required.')).toBeInTheDocument();
  });

  it('W01 AS-67: console spies receive no password, e-mail or request body', async () => {
    const user = userEvent.setup();
    const spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    server.use(http.post(`${origin}/api/auth/register`, () => HttpResponse.json({ code: 'weak_password' }, { status: 422 })));
    mount();
    await fill(user);
    await user.click(submit());
    await screen.findByText(/known data breach/);
    server.use(http.post(`${origin}/api/auth/register`, () => HttpResponse.error()));
    await user.type(password(), PASSWORD);
    await user.type(confirm(), PASSWORD);
    await user.click(submit());
    await screen.findByRole('alert');
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('new@example.com');
  });
});
