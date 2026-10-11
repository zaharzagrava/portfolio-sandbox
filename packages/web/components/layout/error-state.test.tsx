import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorState } from './system-states';
import type { Problem } from '@/lib/problem';

const problem = (over: Partial<Problem> & Record<string, unknown> = {}): Problem => ({ status: 500, errors: [], ...over }) as Problem;

const GENERIC = 'We hit an unexpected problem. Try again, and if it keeps happening come back in a few minutes.';
const UNAVAILABLE = 'This part of the marketplace is temporarily unavailable. Try again in a moment.';
const FALLBACK_4XX = "Something didn't work. Check the details and try again.";

describe('W07 ErrorState (AS-13)', () => {
  it('W07 AS-13: 401 renders nothing (W01 handles the ended session)', () => {
    const { container } = render(<ErrorState problem={problem({ status: 401 })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('W07 AS-13: 403 is the access-denied state', () => {
    render(<ErrorState problem={problem({ status: 403 })} />);
    expect(screen.getByRole('heading', { level: 1, name: "You don't have access" })).toBeInTheDocument();
    expect(screen.getByText("Your account can't open this page. If you think this is a mistake, contact the shop owner or an administrator.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
  });

  it('W07 AS-13: 404 is the not-found state', () => {
    render(<ErrorState problem={problem({ status: 404 })} />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toBeInTheDocument();
  });

  it('W07 AS-13: 409 explains and offers Reload', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<ErrorState problem={problem({ status: 409 })} />);
    expect(screen.getByText('This changed while you were looking at it. Reload and try again.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it.each([400, 405, 410, 422, 451])('W07 AS-13: %i uses the W01 4xx fallback', (status) => {
    render(<ErrorState problem={problem({ status })} />);
    expect(screen.getByText(FALLBACK_4XX)).toBeInTheDocument();
  });

  it.each([
    [59, 'Too many requests. Try again in 59 seconds.'],
    [1, 'Too many requests. Try again in 1 second.'],
    [60, 'Too many requests. Try again in 1 minute.'],
    [61, 'Too many requests. Try again in 2 minutes.'],
    [3599, 'Too many requests. Try again in 60 minutes.'],
    [3600, 'Too many requests. Try again in 1 hour.'],
    [3601, 'Too many requests. Try again in 2 hours.'],
    [undefined, 'Too many requests. Try again later.'],
  ])('W07 AS-13: 429 with Retry-After %s reads "%s"', (retryAfterSeconds, text) => {
    render(<ErrorState problem={problem({ status: 429, retryAfterSeconds })} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it.each([502, 503])('W07 AS-13: %i is "temporarily unavailable" with Try again and the reference', async (status) => {
    const onRetry = vi.fn();
    render(<ErrorState problem={problem({ status, requestId: 'req-123' })} onRetry={onRetry} />);
    expect(screen.getByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByText('Reference: req-123')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each([
    ['500 with a request id', problem({ status: 500, requestId: 'req-9' }), 'Reference: req-9'],
    ['500 without a request id', problem({ status: 500 }), null],
    ['network failure', problem({ status: 0 }), null],
    ['non-problem body (no code)', problem({ status: 504, code: undefined }), null],
  ])('W07 AS-13: %s -> the generic text', (_label, p, reference) => {
    render(<ErrorState problem={p} />);
    expect(screen.getByText(GENERIC)).toBeInTheDocument();
    if (reference) expect(screen.getByText(reference)).toBeInTheDocument();
    else expect(screen.queryByText(/Reference:/)).not.toBeInTheDocument();
  });

  it('W07 AS-13: no problem at all -> the generic text; an explicit reference wins', () => {
    render(<ErrorState reference="digest-1" />);
    expect(screen.getByText(GENERIC)).toBeInTheDocument();
    expect(screen.getByText('Reference: digest-1')).toBeInTheDocument();
  });

  it('W07 AS-13: title and detail from the server are never rendered', () => {
    const leaking = problem({ status: 500, code: 'internal_error', title: 'SQLSTATE 42P01 relation "users"', detail: 'at /srv/api/db.ts:12' });
    render(<ErrorState problem={leaking} />);
    expect(document.body).not.toHaveTextContent(/SQLSTATE|relation|db\.ts/);
  });

  it('W07 AS-13: the state is announced as an alert', () => {
    render(<ErrorState problem={problem({ status: 500 })} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
