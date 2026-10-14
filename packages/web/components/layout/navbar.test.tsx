import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import { Navbar } from './navbar';

let mockPathname = '/';
let mockAuthenticated = false;
let accountMode: 'ok' | 'suspend' | 'throw' = 'ok';
let cartMode: 'ok' | 'throw' = 'ok';
const renders = { account: 0, assistant: 0, theme: 0, bell: 0, cart: 0, search: 0 };
const bellMounts = { count: 0 };

vi.mock('next/navigation', () => ({ usePathname: () => mockPathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ isAuthenticated: mockAuthenticated, user: null, isLoading: false }) }));
vi.mock('@/components/layout/mobile-menu', () => ({ MobileMenu: () => <button type="button" aria-label="Open menu" data-testid="mobile-menu" /> }));
// The real slots are async Server Components (they read the session cookie); here they gate on the mocked session.
vi.mock('@/components/layout/session-slots', () => ({
  MobileLoginSlot: () => null,
  MemberSlot: ({ children }: { children: React.ReactNode }) => (mockAuthenticated ? <>{children}</> : null),
}));
vi.mock('@/components/layout/search-row', () => ({ SearchRow: () => <button type="button" aria-label="Search" data-testid="search-row" /> }));
vi.mock('@/components/layout/theme-control', () => ({
  ThemeControl: () => {
    renders.theme++;
    return <button type="button" aria-label="Theme" data-testid="theme" />;
  },
}));
vi.mock('@/components/search/search-box', () => ({
  SearchBox: () => {
    renders.search++;
    return <input type="search" aria-label="Search products" data-testid="search" />;
  },
}));
vi.mock('@/components/chat/assistant-launcher', () => ({
  AssistantLauncher: () => {
    renders.assistant++;
    return <button type="button" aria-label="AI Assistant" data-testid="assistant" />;
  },
}));
vi.mock('@/components/cart/cart-badge', () => ({
  CartBadge: () => {
    const [n, setN] = useState(0);
    renders.cart++;
    if (cartMode === 'throw') throw new Error('cart exploded');
    return (
      <a href="/cart" aria-label={`Cart, ${n} items`} data-testid="cart" onClick={(e) => (e.preventDefault(), setN(n + 1))}>
        <svg aria-hidden="true" />
      </a>
    );
  },
}));
vi.mock('@/components/notifications/notifications-popover', async () => {
  const { useEffect } = await import('react');
  return {
    NotificationsPopover: () => {
      renders.bell++;
      useEffect(() => {
        bellMounts.count++;
      }, []);
      return <button type="button" aria-label="Notifications" data-testid="bell" />;
    },
  };
});
vi.mock('@/components/auth/account-slot', async (importActual) => {
  const actual = await importActual<typeof import('@/components/auth/account-slot')>();
  const never = new Promise<never>(() => {});
  return {
    ...actual,
    AccountSlot: () => {
      renders.account++;
      if (accountMode === 'suspend') throw never;
      if (accountMode === 'throw') throw new Error('account exploded');
      return <button type="button" aria-label="Account menu" data-testid="account" />;
    },
  };
});

const order = ['logo', 'main-nav', 'search', 'assistant', 'theme', 'cart', 'bell', 'account'];
const positionsOf = (header: HTMLElement) => {
  const tag = (el: Element) => el.getAttribute('data-testid') ?? (el.getAttribute('aria-label') === 'Main' ? 'main-nav' : el.getAttribute('data-slot') === 'logo' ? 'logo' : '');
  return Array.from(header.querySelectorAll('[data-testid], nav[aria-label="Main"], [data-slot="logo"]'))
    .map(tag)
    .filter((name) => order.includes(name));
};

describe('W07 navbar (AS-01, AS-04, AS-32)', () => {
  beforeEach(() => {
    mockPathname = '/products/p1';
    mockAuthenticated = false;
    accountMode = 'ok';
    cartMode = 'ok';
    Object.keys(renders).forEach((key) => (renders[key as keyof typeof renders] = 0));
    bellMounts.count = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('W07 AS-01: a banner with the logo, "Main" navigation and the slots in the contract order (member)', () => {
    mockAuthenticated = true;
    render(<Navbar />);
    const header = screen.getByRole('banner');
    expect(positionsOf(header)).toEqual(order);
  });

  it('W07 AS-01: the logo link is named "Marketplace home" and goes to /', () => {
    render(<Navbar />);
    expect(screen.getByRole('link', { name: 'Marketplace home' })).toHaveAttribute('href', '/');
  });

  it('W07 AS-01: the "Main" navigation holds Browse and Developers', () => {
    render(<Navbar />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Browse', '/search'],
      ['Developers', '/developers/docs'],
    ]);
  });

  it.each([
    ['/search', 'Browse'],
    ['/search?x', 'Browse'],
    ['/developers/docs', 'Developers'],
  ])('W07 AS-32: on %s the %s link is aria-current="page", the other is not', (path, current) => {
    mockPathname = path.split('?')[0];
    render(<Navbar />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const link of within(nav).getAllByRole('link')) {
      if (link.textContent === current) expect(link).toHaveAttribute('aria-current', 'page');
      else expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('W07 AS-01: the hamburger and the search button belong to the compact layout (hidden from 1024 px), the desktop search and assistant to the wide one', () => {
    render(<Navbar />);
    for (const id of ['mobile-menu', 'search-row']) expect(screen.getByTestId(id).closest('[class*="lg:hidden"]'), id).not.toBeNull();
    for (const id of ['search', 'assistant']) expect(screen.getByTestId(id).closest('[class*="lg:block"], [class*="lg:flex"]'), id).not.toBeNull();
  });

  it('W07 AS-04: the cart link is present for visitors and members', () => {
    const { unmount } = render(<Navbar />);
    expect(screen.getByTestId('cart')).toBeInTheDocument();
    unmount();
    mockAuthenticated = true;
    render(<Navbar />);
    expect(screen.getByTestId('cart')).toBeInTheDocument();
  });

  it('W07 AS-04: for a visitor the bell is absent and no request is made', async () => {
    const calls: string[] = [];
    server.use(http.all('*', ({ request }) => (calls.push(request.url), HttpResponse.json({}))));
    render(<Navbar />);
    await act(async () => {});
    expect(screen.queryByTestId('bell')).not.toBeInTheDocument();
    expect(bellMounts.count).toBe(0);
    expect(calls).toEqual([]);
  });

  it('W07 AS-04: for a member the bell is present', () => {
    mockAuthenticated = true;
    render(<Navbar />);
    expect(screen.getByTestId('bell')).toBeInTheDocument();
  });

  it('W07 AS-04: while the account slot loads, a fixed-size skeleton (the account button size) stands in', () => {
    accountMode = 'suspend';
    render(<Navbar />);
    const skeleton = document.querySelector('[data-slot="account-skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton!.className).toContain('size-9');
    expect(screen.queryByTestId('account')).not.toBeInTheDocument();
  });

  it.each([
    ['account', () => (accountMode = 'throw'), 'account'],
    ['cart', () => (cartMode = 'throw'), 'cart'],
  ])('W07 AS-04: a throwing %s slot renders nothing and the header survives', (_name, arm, testid) => {
    arm();
    render(<Navbar />);
    expect(screen.queryByTestId(testid)).not.toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Marketplace home' })).toBeInTheDocument();
    expect(screen.getByTestId('theme')).toBeInTheDocument();
  });

  it('W07 AS-32: icon-only controls have accessible names and decorative icons are hidden', () => {
    mockAuthenticated = true;
    render(<Navbar />);
    const header = screen.getByRole('banner');
    for (const control of within(header).getAllByRole('button')) expect(control).toHaveAccessibleName();
    for (const link of within(header).getAllByRole('link')) expect(link).toHaveAccessibleName();
    for (const icon of header.querySelectorAll('svg')) expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('W07 AS-38: a cart change re-renders only the cart slot', async () => {
    mockAuthenticated = true;
    render(<Navbar />);
    const before = { ...renders };
    await userEvent.click(screen.getByTestId('cart'));
    expect(renders.cart).toBeGreaterThan(before.cart);
    expect({ ...renders, cart: 0 }).toEqual({ ...before, cart: 0 });
  });
});
