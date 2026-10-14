import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/lib/auth/session-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session-sync')>()),
  announceAuth: vi.fn(),
}));

import { toast } from 'sonner';
import { queryKeys } from '@/lib/query-keys';
import { SessionsPanel } from './sessions-panel';

const origin = 'http://localhost:3000';
const NOW = new Date('2026-06-01T12:00:00.000Z').getTime();

const session = (over: Record<string, unknown>) => ({
  sessionId: 's-1',
  device: 'Chrome on Linux',
  ip: '203.0.113.7',
  createdAt: '2026-05-30T09:00:00.000Z',
  lastUsedAt: '2026-06-01T11:55:00.000Z',
  current: false,
  ...over,
});
const LIST = [
  session({ sessionId: 'old', device: 'Firefox on Windows', createdAt: '2026-05-01T09:00:00.000Z', lastUsedAt: '2026-05-02T09:00:00.000Z' }),
  session({ sessionId: 'here', device: 'Safari on macOS', current: true, createdAt: '2026-06-01T08:00:00.000Z', lastUsedAt: '2026-06-01T11:59:30.000Z' }),
  session({ sessionId: 'other', device: 'Chrome on Android', createdAt: '2026-05-30T09:00:00.000Z' }),
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionsPanel now={NOW} />
    </QueryClientProvider>,
  );
  return client;
}
const stubList = (items: unknown[] = LIST) => server.use(http.get(`${origin}/api/auth/sessions`, () => HttpResponse.json(items)));
const rowOf = (device: string) => screen.getByText(device).closest('li') as HTMLElement;

describe('SessionsPanel', () => {
  beforeEach(() => {
    Object.values(router).forEach((fn) => fn.mockClear());
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-54: shows skeleton rows while loading', async () => {
    server.use(
      http.get(`${origin}/api/auth/sessions`, async () => {
        await delay(100);
        return HttpResponse.json(LIST);
      }),
    );
    mount();
    expect(screen.getByTestId('sessions-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText('Safari on macOS')).toBeInTheDocument();
  });

  it('W01 AS-54: a failed load shows the message with Retry', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${origin}/api/auth/sessions`, () => HttpResponse.json({ code: 'internal_error' }, { status: 500 })));
    mount();
    expect(await screen.findByText("We couldn't load this section.")).toBeInTheDocument();
    stubList();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Safari on macOS')).toBeInTheDocument();
  });

  it('W01 AS-54: lists newest first with time elements; the current row says "This device" and has no revoke control', async () => {
    stubList();
    mount();
    await screen.findByText('Safari on macOS');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => within(row).getAllByText(/Safari|Chrome|Firefox/)[0].textContent)).toEqual(['Safari on macOS', 'Chrome on Android', 'Firefox on Windows']);
    const current = rowOf('Safari on macOS');
    expect(within(current).getByText('This device')).toBeInTheDocument();
    expect(within(current).queryByRole('button')).toBeNull();
    expect(current.querySelectorAll('time')).toHaveLength(2);
    expect(within(current).getByText('203.0.113.7')).toBeInTheDocument();
    expect(within(current).getByText(/Last active/)).toBeInTheDocument();
    expect(current.textContent).toMatch(/Last active\s*30 seconds ago/);
    expect(within(rowOf('Chrome on Android')).getByRole('button', { name: /Log out/ })).toBeInTheDocument();
  });

  it('W01 AS-54: at desktop width the sessions are a table with the five columns', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ ...original(query), matches: true })) as typeof window.matchMedia;
    try {
      stubList();
      mount();
      await screen.findByRole('table');
      expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Device', 'IP address', 'Signed in', 'Last active', 'Actions']);
      expect(screen.getAllByRole('row')).toHaveLength(4);
    } finally {
      window.matchMedia = original;
    }
  });

  it('W01 AS-55: Log out on another device removes the row and announces it', async () => {
    const user = userEvent.setup();
    stubList();
    const deleted: string[] = [];
    server.use(
      http.delete(`${origin}/api/auth/sessions/:id`, ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    mount();
    await screen.findByText('Chrome on Android');
    await user.click(within(rowOf('Chrome on Android')).getByRole('button', { name: /Log out/ }));
    await waitFor(() => expect(screen.queryByText('Chrome on Android')).toBeNull());
    expect(deleted).toEqual(['other']);
    expect(screen.getByRole('status')).toHaveTextContent('Device signed out.');
    expect(screen.getByText('Firefox on Windows')).toBeInTheDocument();
  });

  it('W01 AS-55: 404 session_not_found removes the row with the same announcement', async () => {
    const user = userEvent.setup();
    stubList();
    server.use(http.delete(`${origin}/api/auth/sessions/:id`, () => HttpResponse.json({ code: 'session_not_found' }, { status: 404 })));
    mount();
    await screen.findByText('Chrome on Android');
    await user.click(within(rowOf('Chrome on Android')).getByRole('button', { name: /Log out/ }));
    await waitFor(() => expect(screen.queryByText('Chrome on Android')).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('Device signed out.');
  });

  it('W01 AS-55: other errors toast and keep the row', async () => {
    const user = userEvent.setup();
    stubList();
    server.use(http.delete(`${origin}/api/auth/sessions/:id`, () => HttpResponse.json({ code: 'internal_error' }, { status: 500 })));
    mount();
    await screen.findByText('Chrome on Android');
    await user.click(within(rowOf('Chrome on Android')).getByRole('button', { name: /Log out/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Something went wrong on our side. Try again.'));
    expect(screen.getByText('Chrome on Android')).toBeInTheDocument();
    expect(within(rowOf('Chrome on Android')).getByRole('button', { name: /Log out/ })).toBeEnabled();
  });

  it('W01 AS-56: Log out of all devices asks first, then ends the local session and goes to the notice', async () => {
    const user = userEvent.setup();
    stubList();
    let revoked = 0;
    let bffEnded = 0;
    server.use(
      http.post(`${origin}/api/auth/logout-all`, () => {
        revoked += 1;
        return HttpResponse.json({ revokedSessions: 3 });
      }),
      // The BFF keeps its own session record and cookies: ending "here" is a BFF sign-out.
      http.post(`${origin}/api/bff/session/logout`, () => {
        bffEnded += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = mount();
    await screen.findByText('Safari on macOS');
    await user.click(screen.getByRole('button', { name: 'Log out of all devices' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This signs you out here too.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(revoked).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Log out of all devices' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Log out everywhere' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login?notice=signed_out_everywhere'));
    expect(revoked).toBe(1);
    expect(bffEnded).toBe(1);
    expect(client.getQueryData(queryKeys.auth.session())).toBeNull();
  });

  it('W01 AS-56: a failed log out everywhere keeps the dialog and toasts', async () => {
    const user = userEvent.setup();
    stubList();
    server.use(http.post(`${origin}/api/auth/logout-all`, () => HttpResponse.json({ code: 'internal_error' }, { status: 500 })));
    mount();
    await screen.findByText('Safari on macOS');
    await user.click(screen.getByRole('button', { name: 'Log out of all devices' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Log out everywhere' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(router.replace).not.toHaveBeenCalled();
  });
});
