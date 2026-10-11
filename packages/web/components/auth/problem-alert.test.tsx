import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Problem } from '@/lib/api/errors';
import { ProblemAlert } from './problem-alert';

const problem = (over: Partial<Problem>): Problem => ({ status: 400, errors: [], ...over });

describe('ProblemAlert', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['W01 AS-66: invalid_credentials', problem({ status: 401, code: 'invalid_credentials' }), 'login', 'The email or password is incorrect.'],
    ['W01 AS-66: invalid_mfa_code', problem({ status: 401, code: 'invalid_mfa_code' }), 'mfa-login', "That code isn't right. Check your authenticator app and try again."],
    ['W01 AS-66: invalid_code', problem({ status: 422, code: 'invalid_code' }), 'mfa-setup', "That code isn't right. Check your authenticator app and try again."],
    ['W01 AS-66: mfa_not_pending at sign-in', problem({ status: 409, code: 'mfa_not_pending' }), 'mfa-login', 'Your sign-in timed out. Sign in again.'],
    ['W01 AS-66: mfa_not_pending at setup', problem({ status: 409, code: 'mfa_not_pending' }), 'mfa-setup', 'Setup timed out. Start again.'],
    ['W01 AS-66: invalid_reset_token', problem({ status: 400, code: 'invalid_reset_token' }), 'reset-confirm', 'This reset link is invalid or has expired.'],
    ['W01 AS-66: weak_password', problem({ status: 422, code: 'weak_password' }), 'register', 'This password has appeared in a known data breach. Choose a different one.'],
    ['W01 AS-66: rate_limited with seconds', problem({ status: 429, code: 'rate_limited', retryAfterSeconds: 30 }), 'login', 'Too many sign-in attempts. Try again in 30 seconds.'],
    ['W01 AS-66: rate_limited with minutes', problem({ status: 429, code: 'rate_limited', retryAfterSeconds: 61 }), 'mfa-login', 'Too many incorrect codes. Try again in 2 minutes.'],
    ['W01 AS-66: rate_limited without header', problem({ status: 429, code: 'rate_limited' }), 'register', 'Too many sign-up attempts. Try again later.'],
    ['W01 AS-66: 503', problem({ status: 503, code: 'session_unavailable' }), 'login', 'This is taking longer than expected. Try again in a moment.'],
    ['W01 AS-66: 500', problem({ status: 500 }), 'login', 'Something went wrong on our side. Try again.'],
    ['W01 AS-66: no response', problem({ status: 0 }), 'login', 'You appear to be offline. Check your connection and try again.'],
    ['W01 AS-66: unknown 4xx', problem({ status: 418, code: 'teapot' }), 'generic', "Something didn't work. Check the details and try again."],
    ['W01 AS-66: last_login_method', problem({ status: 409, code: 'last_login_method' }), 'generic', 'This is your only way to sign in. Add another sign-in method first.'],
  ] as const)('%s shows the catalogue copy', (_name, input, context, copy) => {
    render(<ProblemAlert problem={input} context={context} />);
    expect(screen.getByRole('alert')).toHaveTextContent(copy);
  });

  it('W01 AS-67: never renders raw detail, title or message text from the problem', () => {
    const hostile = { status: 500, errors: [], code: 'boom', detail: 'SELECT * FROM users', title: 'Stack trace', message: 'secret' } as Problem;
    render(<ProblemAlert problem={hostile} />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toBe('Something went wrong on our side. Try again.');
    expect(text).not.toMatch(/SELECT|Stack|secret/);
  });

  it('W01 AS-66: shows the Reference id for 5xx and unknown errors, selectable text', () => {
    render(<ProblemAlert problem={problem({ status: 500, requestId: 'req-123' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Reference: req-123');
  });

  it('W01 AS-66: shows no Reference id for 503, 401 or when none exists', () => {
    const { rerender } = render(<ProblemAlert problem={problem({ status: 503, requestId: 'req-1' })} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Reference');
    rerender(<ProblemAlert problem={problem({ status: 401, code: 'invalid_credentials', requestId: 'req-2' })} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Reference');
    rerender(<ProblemAlert problem={problem({ status: 500 })} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Reference');
  });

  it.each(['csrf_invalid', 'origin_not_allowed'])('W01 AS-66: %s offers a Reload button that reloads the page', async (code) => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<ProblemAlert problem={problem({ status: 403, code })} context="login" />);
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't verify this request. Reload the page and try again.");
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('W01 AS-66: other problems have no Reload button', () => {
    render(<ProblemAlert problem={problem({ status: 401, code: 'invalid_credentials' })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('W01 AS-66: uses role alert by default and role status when asked, and is focusable for focus management', () => {
    const { rerender } = render(<ProblemAlert problem={problem({ status: 500 })} />);
    expect(screen.getByRole('alert')).toHaveAttribute('tabindex', '-1');
    rerender(<ProblemAlert problem={problem({ status: 500 })} role="status" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W01 AS-66: forwards id and ref so a form can link and focus it', () => {
    const ref = { current: null as HTMLDivElement | null };
    render(<ProblemAlert problem={problem({ status: 500 })} id="form-error" ref={ref} />);
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'form-error');
    expect(ref.current).toBe(screen.getByRole('alert'));
  });
});
