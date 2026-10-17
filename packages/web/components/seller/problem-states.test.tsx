import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Problem } from '@/lib/api/errors';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { SELLER_PROBLEM_STATUS, type SellerProblemCode } from '@/lib/test/seller-handlers';
import { OfflineBanner, ProblemPanel, RateLimitNotice, SectionError } from './problem-states';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/seller/shop-1/inventory' }));

const problem = (status: number, code?: string, extra: Partial<Problem> = {}): Problem => ({ status, ...(code ? { code } : {}), errors: [], requestId: 'req-42', ...extra });

let onlineValue = true;
function setOnline(next: boolean) {
  onlineValue = next;
  act(() => {
    window.dispatchEvent(new Event(next ? 'online' : 'offline'));
  });
}

beforeEach(() => {
  onlineValue = true;
  vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => onlineValue);
  rearmSessionEnd();
});

afterEach(() => {
  setSessionEndHandler(null);
  rearmSessionEnd();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('W04 session ended (AS-87)', () => {
  it('W04 AS-87: a 401 runs the session-ended flow once, however many panels show it, and says so politely (not as an alert)', () => {
    const handler = vi.fn();
    setSessionEndHandler(handler);
    render(
      <>
        <ProblemPanel problem={problem(401, 'session_expired')} />
        <SectionError error={{ response: { status: 401, data: { code: 'invalid_token' } } }} onRetry={() => {}} />
      </>,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('Your session ended. Sign in again to continue.'))).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('W04 offline (AS-88)', () => {
  it('W04 AS-88: the banner shows while offline and clears when the browser is back', () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <OfflineBanner />
      </QueryClientProvider>,
    );
    expect(screen.queryByText("You're offline. Changes can't be saved.")).toBeNull();
    setOnline(false);
    expect(screen.getByRole('status')).toHaveTextContent("You're offline. Changes can't be saved.");
    setOnline(true);
    expect(screen.queryByText("You're offline. Changes can't be saved.")).toBeNull();
  });

  it('W04 AS-88: a failed action shows the alert with "Try again", which calls onRetry', async () => {
    const onRetry = vi.fn();
    render(<ProblemPanel problem={problem(0)} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reach the server. Check your connection and try again.");
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('W04 AS-88: open seller queries refetch once when the browser comes back online', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const queryFn = vi.fn(async () => ({ ok: true }));
    function Probe() {
      useQuery({ queryKey: ['seller', 'shop-1', 'overview', '{}'], queryFn });
      return null;
    }
    render(
      <QueryClientProvider client={client}>
        <OfflineBanner />
        <Probe />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(client.getQueryState(['seller', 'shop-1', 'overview', '{}'])?.status).toBe('success'));
    expect(queryFn).toHaveBeenCalledTimes(1);
    setOnline(false);
    expect(queryFn).toHaveBeenCalledTimes(1);
    setOnline(true);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});

describe('W04 error catalogue (AS-89)', () => {
  const codes = Object.keys(SELLER_PROBLEM_STATUS) as SellerProblemCode[];

  it.each(codes)('W04 AS-89: %s shows catalogue text, never raw JSON, a bare status, or the server title and detail', (code) => {
    setSessionEndHandler(() => {});
    const status = SELLER_PROBLEM_STATUS[code];
    const { container } = render(<ProblemPanel problem={problem(status, code, { retryAfterSeconds: 7 })} onRetry={() => {}} />);
    const text = container.textContent ?? '';
    expect(text.trim().length).toBeGreaterThan(8);
    expect(text).not.toMatch(/Server title|Server detail|\[object|undefined|null|[{}]/);
    expect(text.trim()).not.toMatch(/^\d{3}$/);
    expect(text).not.toContain(code);
    if (status >= 500) expect(text).toContain('Reference: req-42');
  });

  it('W04 AS-89: a 5xx shows the generic text, "Reference: {requestId}" and a Copy button that copies the id', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ProblemPanel problem={problem(500, 'internal_error')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    expect(screen.getByRole('alert')).toHaveTextContent('Reference: req-42');
    await userEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('req-42');
  });

  it('W04 AS-89: a body that was not problem+json shows the generic text without a reference', () => {
    const { container } = render(<ProblemPanel problem={{ status: 502, errors: [] }} />);
    expect(container.textContent).not.toContain('Reference');
    expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong|couldn't load|didn't work/i);
  });

  it('W04 AS-89: 400 invalid_cursor says the link is no longer valid and links to the first page', () => {
    render(<ProblemPanel problem={problem(400, 'invalid_cursor')} firstPageHref="/dashboard/seller/shop-1/inventory" />);
    expect(screen.getByText('That page link is no longer valid.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute('href', '/dashboard/seller/shop-1/inventory');
  });

  it('W04 AS-89: invalid_cursor without a given first page links to the current path (no cursor)', () => {
    render(<ProblemPanel problem={problem(400, 'invalid_cursor')} />);
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute('href', '/dashboard/seller/shop-1/inventory');
  });

  it('W04 AS-89: a section error says what failed to load and offers "Try again"', async () => {
    const onRetry = vi.fn();
    render(<SectionError error={{ response: { status: 503, data: { code: 'upstream_unavailable', requestId: 'req-9' } } }} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load this right now. Try again in a moment.");
    expect(screen.getByRole('alert')).toHaveTextContent('Reference: req-9');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('W04 rate limits (AS-90)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('W04 AS-90: the notice counts down once per second, announces the start and the end once, and tells the caller when it may retry', () => {
    const states: boolean[] = [];
    render(<RateLimitNotice seconds={3} onActiveChange={(active) => states.push(active)} />);
    const visible = screen.getByText('Too many requests. Try again in 3 s.');
    expect(visible).toBeInTheDocument();
    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('Try again in 3 seconds.');
    expect(live).not.toContainElement(visible);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Too many requests. Try again in 2 s.')).toBeInTheDocument();
    expect(live).toHaveTextContent('Try again in 3 seconds.');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText(/Try again in \d s\./)).toBeNull();
    expect(live).toHaveTextContent('You can try again now.');
    expect(states[0]).toBe(true);
    expect(states.at(-1)).toBe(false);
  });

  it('W04 AS-90: a 429 problem in a panel shows the sentence with the subject and the Retry-After seconds', () => {
    render(<ProblemPanel problem={problem(429, 'rate_limited', { retryAfterSeconds: 5 })} subject="attempts" />);
    expect(screen.getByText('Too many attempts. Try again in 5 s.')).toBeInTheDocument();
  });
});
