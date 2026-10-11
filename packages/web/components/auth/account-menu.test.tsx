import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AccountSlotClient, MobileAccountEntries, MobileLoginLink } from './account-menu';

const origin = 'http://localhost:3000';
const jane = { id: 'u1', email: 'jane.doe@example.com', role: 'USER' as const };
const view = (role = 'USER') => ({ user: { id: 'u1', email: jane.email, role }, expiresAt: '2026-01-02T00:00:00.000Z' });

let client: QueryClient;
const mount = (ui: ReactNode) => render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

describe('W01 account menu (US3)', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    Object.values(router).forEach((fn) => fn.mockClear());
    toast.mockClear();
    toast.error.mockClear();
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-17: anonymous desktop slot shows Log in and Sign up links, nothing else', () => {
    mount(<AccountSlotClient initialUser={null} />);
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('W01 AS-17: anonymous mobile header has an icon link named Log in, and the sheet lists Log in then Sign up first', () => {
    client.setQueryData(queryKeys.auth.session(), null);
    mount(
      <>
        <MobileLoginLink />
        <MobileAccountEntries />
      </>,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['', 'Log in', 'Sign up']);
    expect(links[0]).toHaveAccessibleName('Log in');
    expect(links[0]).toHaveAttribute('href', '/login');
    expect(links[1]).toHaveAttribute('href', '/login');
    expect(links[2]).toHaveAttribute('href', '/register');
  });

  it('W01 AS-17: the mobile header icon link is absent for a member', () => {
    client.setQueryData(queryKeys.auth.session(), jane);
    mount(<MobileLoginLink />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('W01 AS-18: a signed-in member never gets Log in or Sign up, from the first render on', () => {
    mount(<AccountSlotClient initialUser={jane} />);
    expect(screen.queryByRole('link', { name: /Log in|Sign up/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('W01 AS-19: the button is named "Account menu" and shows two-letter initials from the e-mail local part', () => {
    mount(<AccountSlotClient initialUser={jane} />);
    const button = screen.getByRole('button', { name: 'Account menu' });
    expect(button).toHaveTextContent('JA');
    expect(button).toHaveClass('size-9');
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
    ['ArrowDown', '{ArrowDown}'],
  ])('W01 AS-19: %s opens the menu, arrow keys move, Escape closes it and returns focus to the button', async (_name, key) => {
    mount(<AccountSlotClient initialUser={jane} />);
    const button = screen.getByRole('button', { name: 'Account menu' });
    button.focus();
    await userEvent.keyboard(key);
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}');
    expect(menu.contains(document.activeElement)).toBe(true);
    const focused = document.activeElement;
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).not.toBe(focused);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(button).toHaveFocus();
  });

  it('W01 AS-19: the menu shows the e-mail and role, then Dashboard, Orders, Account & security, Log out in order', async () => {
    mount(<AccountSlotClient initialUser={jane} />);
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('jane.doe@example.com')).toBeInTheDocument();
    expect(within(menu).getByText('jane.doe@example.com').className).toMatch(/break-all|break-words/);
    expect(within(menu).getByText(/Member/)).toBeInTheDocument();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Dashboard', 'Orders', 'Account & security', 'Log out']);
    expect(items[0]).toHaveAttribute('href', '/dashboard');
    expect(items[1]).toHaveAttribute('href', '/dashboard/orders');
    expect(items[2]).toHaveAttribute('href', '/account/security');
  });

  it('W01 AS-19: the Admin entry follows Account & security for ADMIN only', async () => {
    mount(<AccountSlotClient initialUser={{ ...jane, role: 'ADMIN' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent?.trim());
    expect(items).toEqual(['Dashboard', 'Orders', 'Account & security', 'Admin', 'Log out']);
  });

  it('W01 AS-19: the mobile sheet shows a labelled Account group with the e-mail and the same entries', () => {
    client.setQueryData(queryKeys.auth.session(), jane);
    mount(<MobileAccountEntries />);
    const group = screen.getByRole('group', { name: 'Account' });
    expect(within(group).getByText('jane.doe@example.com')).toBeInTheDocument();
    expect(within(group).getAllByRole('link').map((link) => link.textContent?.trim())).toEqual(['Dashboard', 'Orders', 'Account & security']);
    expect(within(group).getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Log in|Sign up/ })).not.toBeInTheDocument();
  });

  it('W01 AS-20: with no known user and the check failing, a retry button replaces the anonymous controls and retrying recovers', async () => {
    let up = false;
    server.use(http.get(`${origin}/api/bff/session`, () => (up ? HttpResponse.json(view()) : HttpResponse.json({ code: 'session_unavailable' }, { status: 503 }))));
    mount(<AccountSlotClient />);
    const retry = await screen.findByRole('button', { name: 'Sign-in status unavailable. Retry' });
    expect(screen.queryByRole('link', { name: /Log in|Sign up/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
    up = true;
    await userEvent.click(retry);
    expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  it('W01 AS-20: when the check fails after a menu was shown, the last known menu stays usable next to the retry button, and focus refetches', async () => {
    let up = false;
    server.use(http.get(`${origin}/api/bff/session`, () => (up ? HttpResponse.json(view()) : HttpResponse.error())));
    mount(<AccountSlotClient initialUser={jane} />);
    await act(async () => {
      // the seeded value is fresh; a focus refetch is 'always'
      window.dispatchEvent(new Event('visibilitychange'));
    });
    const retry = await screen.findByRole('button', { name: 'Sign-in status unavailable. Retry' });
    expect(screen.queryByRole('link', { name: /Log in|Sign up/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitem', { name: 'Dashboard' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    up = true;
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(retry).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('W01 AS-23: when the session query gets a new role, the menu shows it without a reload', async () => {
    mount(<AccountSlotClient initialUser={jane} />);
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByText(/Member/)).toBeInTheDocument();
    await act(async () => client.setQueryData(queryKeys.auth.session(), { ...jane, role: 'SELLER' }));
    expect(await screen.findByText(/Seller/)).toBeInTheDocument();
    expect(screen.queryByText(/Member/)).not.toBeInTheDocument();
  });

  it('W01 AS-24: Log out requests the BFF sign-out, then goes to /login?notice=signed_out with an anonymous slot', async () => {
    server.use(http.post(`${origin}/api/bff/session/logout`, () => new HttpResponse(null, { status: 204 })));
    mount(<AccountSlotClient initialUser={jane} />);
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login?notice=signed_out'));
    expect(await screen.findByRole('link', { name: 'Log in' })).toBeInTheDocument();
  });

  it.each([
    ['500', () => HttpResponse.json({ code: 'internal' }, { status: 500 }), "We couldn't sign you out. Try again.", 'Try again'],
    ['network failure', () => HttpResponse.error(), "We couldn't sign you out. Try again.", 'Try again'],
    ['403 csrf_invalid', () => HttpResponse.json({ code: 'csrf_invalid' }, { status: 403 }), 'Reload the page and try again.', 'Reload'],
  ])('W01 AS-25: a failed Log out (%s) keeps the member signed in and toasts "%s" with the %s action', async (_name, answer, copy, label) => {
    server.use(http.post(`${origin}/api/bff/session/logout`, answer));
    mount(<AccountSlotClient initialUser={jane} />);
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(copy, { action: expect.objectContaining({ label }) });
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
  });
});
