import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useShopWritable } from '@/lib/seller/permissions';
import { ALL_PERMISSIONS, SELLER_SHOP_ID, VIEWER_PERMISSIONS, shopFixture, shopListItemFixture } from '@/lib/test/seller-handlers';
import { DashboardShell } from './dashboard-shell';
import { PageAccess, ShopFrame, requireSellerSession } from './shop-frame';
import { ShellSkeleton } from './shell-skeleton';
import { ShopNotFound } from '@/components/seller/shop-not-found';

let mockPathname = `/dashboard/seller/${SELLER_SHOP_ID}`;
const requireServerSession = vi.hoisted(() => vi.fn());
const readShop = vi.hoisted(() => vi.fn());
const readMyShops = vi.hoisted(() => vi.fn());
const NOT_FOUND = 'NEXT_NOT_FOUND';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock('@/lib/auth/session.server', () => ({ requireServerSession }));
vi.mock('@/lib/server/seller.server', () => ({ readShop, readMyShops }));

const OTHER = '2d9e8f7a-6b5c-4d3e-9f10-a1b2c3d4e5f6';
const frame = (shopId = SELLER_SHOP_ID, children: ReactElement = <p>page body</p>) => ShopFrame({ params: Promise.resolve({ shopId }), children });
const shell = (shop = shopFixture(), shops = [shopListItemFixture(), shopListItemFixture({ id: OTHER, name: 'Wood Shop', slug: 'wood-shop' })]) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DashboardShell shop={shop} shops={shops} nextCursor={null}>
        <h1>Content</h1>
      </DashboardShell>
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockPathname = `/dashboard/seller/${SELLER_SHOP_ID}`;
  requireServerSession.mockReset().mockResolvedValue({ id: 'u1' });
  readShop.mockReset().mockResolvedValue({ ok: true, data: shopFixture() });
  readMyShops.mockReset().mockResolvedValue({ ok: true, data: { items: [shopListItemFixture()], nextCursor: null } });
});

describe('W04 shell guard (AS-84)', () => {
  it('W04 AS-84: the frame requires the session first, with the shop address as returnTo, before anything is read', async () => {
    await frame();
    expect(requireServerSession).toHaveBeenCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}`);
    expect(requireServerSession.mock.invocationCallOrder[0]).toBeLessThan(readShop.mock.invocationCallOrder[0]!);
  });

  it('W04 AS-84: an anonymous visitor is redirected and nothing is read', async () => {
    requireServerSession.mockRejectedValue(new Error('NEXT_REDIRECT /login?returnTo=%2Fdashboard%2Fseller'));
    await expect(frame()).rejects.toThrow('NEXT_REDIRECT /login');
    expect(readShop).not.toHaveBeenCalled();
    expect(readMyShops).not.toHaveBeenCalled();
  });

  it('W04 AS-84: a page guard passes the path and the query as returnTo', async () => {
    await requireSellerSession(`/dashboard/seller/${SELLER_SHOP_ID}/team`, { tab: 'invites', status: ['pending', 'expired'], empty: undefined });
    expect(requireServerSession).toHaveBeenCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}/team?tab=invites&status=pending&status=expired`);
    await requireSellerSession('/dashboard/seller', {});
    expect(requireServerSession).toHaveBeenLastCalledWith('/dashboard/seller');
  });

  it('W04 AS-84: a read that answers 401 goes to sign-in with the same returnTo', async () => {
    readShop.mockResolvedValue({ ok: false, status: 401, code: 'unauthenticated' });
    await expect(frame()).rejects.toThrow(`NEXT_REDIRECT /login?returnTo=${encodeURIComponent(`/dashboard/seller/${SELLER_SHOP_ID}`)}`);
  });
});

describe('W04 shop not found (AS-85)', () => {
  it.each([
    ['unknown', SELLER_SHOP_ID, { ok: false, status: 404, code: 'shop_not_found' }],
    ['malformed', 'not-a-uuid', { ok: false, status: 404, code: 'shop_not_found' }],
    ['foreign', OTHER, { ok: false, status: 403, code: 'permission_denied' }],
  ])('W04 AS-85: a %s shop answers the not-found page', async (_name, shopId, result) => {
    readShop.mockResolvedValue(result);
    await expect(frame(shopId)).rejects.toThrow(NOT_FOUND);
  });

  it('W04 AS-85: another failure is an error for the error boundary, not a not-found', async () => {
    readShop.mockResolvedValue({ ok: false, status: 503, code: 'upstream_unavailable' });
    await expect(frame()).rejects.toThrow(/^(?!NEXT_NOT_FOUND)/);
  });

  it('W04 AS-85: the page says "We couldn\'t find that shop." with a link "Your shops", the same for every case', () => {
    const first = render(<ShopNotFound />);
    expect(screen.getByText("We couldn't find that shop.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Your shops' })).toHaveAttribute('href', '/dashboard/seller');
    const html = first.container.innerHTML;
    first.unmount();
    expect(render(<ShopNotFound />).container.innerHTML).toBe(html);
  });
});

describe('W04 read-only shop (AS-86)', () => {
  it('W04 AS-86: an active shop has no banner', () => {
    shell();
    expect(screen.queryByLabelText('Shop status')).toBeNull();
  });

  it.each([
    ['SUSPENDED', 'This shop is suspended. You can view data but not make changes.'],
    ['DELETING', 'This shop is being closed. You can view data but not make changes.'],
  ])('W04 AS-86: a %s shop shows its banner above the content and the write controls carry the reason', (status, text) => {
    shell(shopFixture({ status }));
    const banner = screen.getByLabelText('Shop status');
    expect(banner).toHaveTextContent(text);
    expect(banner.compareDocumentPosition(screen.getByRole('heading', { name: 'Content' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    function WriteControl() {
      const { writable, reason } = useShopWritable(shopFixture({ status }));
      return (
        <>
          <button type="button" disabled={!writable} aria-describedby="why">
            Add product
          </button>
          <span id="why">{reason}</span>
        </>
      );
    }
    render(<WriteControl />);
    expect(screen.getByRole('button', { name: 'Add product' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add product' })).toHaveAccessibleDescription(text);
  });
});

describe('W04 loading (AS-91)', () => {
  const root = path.resolve(__dirname, '../../app/dashboard/seller');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(path.join(dir, name)).isDirectory() ? walk(path.join(dir, name)) : [path.join(dir, name)]));

  it('W04 AS-91: the shell fallback is a sidebar and a content skeleton, with no spinner and never the word "Loading..."', () => {
    const { container } = render(<ShellSkeleton />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(8);
    expect(container.textContent).not.toMatch(/loading/i);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('W04 AS-91: the shop segment has a loading.tsx and every loading.tsx renders skeletons only', async () => {
    const files = walk(root).filter((file) => /\/loading\.tsx$/.test(file));
    expect(files.some((file) => file.endsWith('[shopId]/loading.tsx'))).toBe(true);
    for (const file of files) {
      const { default: Loading } = (await import(/* @vite-ignore */ file)) as { default: () => ReactElement };
      const { container, unmount } = render(<Loading />);
      expect(container.querySelectorAll('[data-slot="skeleton"]').length, file).toBeGreaterThan(3);
      expect(container.textContent, file).not.toMatch(/loading/i);
      unmount();
    }
  });

  it('W04 AS-91: no seller page keeps the blanket instant opt-out except those a later task rewrites, and the shell has no "Loading..."', () => {
    const shellSource = readFileSync(path.resolve(__dirname, 'dashboard-shell.tsx'), 'utf8');
    expect(shellSource).not.toMatch(/Loading\.\.\./);
    expect(shellSource).not.toMatch(/^['"]use client['"]/m);
    expect(shellSource).not.toMatch(/useAuth|\.role\b|myRole ===|isSeller/);
    const offenders = walk(root).filter((file) => /\.tsx?$/.test(file) && /export const instant = false/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(root, file)).filter((file) => file.startsWith('[shopId]'))).toEqual([]);
  });
});

describe('W04 shell frame (AS-98)', () => {
  it('W04 AS-98: the sidebar is a navigation named "Seller" with the groups Shop, Developers and Account', () => {
    shell();
    const nav = screen.getByRole('navigation', { name: 'Seller' });
    for (const group of ['Shop', 'Developers', 'Account']) expect(within(nav).getByRole('heading', { name: group })).toBeInTheDocument();
    for (const name of ['Overview', 'Inventory', 'Orders', 'Team', 'API keys', 'Webhooks', 'API version', 'Request logs', 'Usage', 'API documentation', 'Account security']) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('href', `/dashboard/seller/${SELLER_SHOP_ID}`);
    expect(within(nav).getByRole('link', { name: 'Account security' })).toHaveAttribute('href', '/account/security');
    expect(screen.getAllByRole('button', { name: /Clay Works/ }).length).toBeGreaterThan(0);
  });

  it('W04 AS-98: the current page carries aria-current="page" and no other entry does', () => {
    mockPathname = `/dashboard/seller/${SELLER_SHOP_ID}/inventory`;
    shell();
    const nav = screen.getByRole('navigation', { name: 'Seller' });
    expect(within(nav).getByRole('link', { name: 'Inventory' })).toHaveAttribute('aria-current', 'page');
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('W04 AS-98: the overview is current only on its own address, a detail page keeps its section current', () => {
    mockPathname = `/dashboard/seller/${SELLER_SHOP_ID}/developers/webhooks/ep-1`;
    shell();
    const nav = screen.getByRole('navigation', { name: 'Seller' });
    expect(within(nav).getByRole('link', { name: 'Webhooks' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('W04 AS-54: entries show only when myPermissions allows them', () => {
    shell(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    const nav = screen.getByRole('navigation', { name: 'Seller' });
    for (const hidden of ['API keys', 'API version', 'Webhooks']) expect(within(nav).queryByRole('link', { name: hidden })).toBeNull();
    for (const shown of ['Overview', 'Inventory', 'Orders', 'Team', 'Request logs', 'Usage', 'API documentation']) expect(within(nav).getByRole('link', { name: shown })).toBeInTheDocument();
  });

  it('W04 AS-54: a shop without myPermissions shows only the entries that need none', () => {
    shell(shopFixture({ myPermissions: [] }));
    const nav = screen.getByRole('navigation', { name: 'Seller' });
    expect(within(nav).queryByRole('link', { name: 'Overview' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'API documentation' })).toBeInTheDocument();
  });

  it('W04 AS-98: the top bar has "Open menu", the shop name and the page name; the drawer opens with the same entries', async () => {
    mockPathname = `/dashboard/seller/${SELLER_SHOP_ID}/orders`;
    shell();
    const bar = screen.getByRole('region', { name: 'Shop bar' });
    expect(within(bar).getByText('Clay Works')).toBeInTheDocument();
    expect(within(bar).getByText('Orders')).toBeInTheDocument();
    const button = within(bar).getByRole('button', { name: 'Open menu' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(button);
    const drawer = screen.getByRole('dialog');
    const nav = within(drawer).getByRole('navigation', { name: 'Seller' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(
      within(screen.getAllByRole('navigation', { name: 'Seller' })[0]!).getAllByRole('link').map((link) => link.textContent),
    );
    expect(within(nav).getByRole('link', { name: 'Orders' })).toHaveAttribute('aria-current', 'page');
  });

  it('W04 AS-98: choosing an entry closes the drawer and focus returns to "Open menu"', async () => {
    shell();
    const button = screen.getByRole('button', { name: 'Open menu' });
    await userEvent.click(button);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Team' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('W04 AS-98: Escape closes the drawer and focus returns to "Open menu"', async () => {
    shell();
    const button = screen.getByRole('button', { name: 'Open menu' });
    await userEvent.click(button);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('W04 AS-98: the content area holds the children after the banner region', () => {
    shell();
    expect(screen.getByRole('heading', { name: 'Content' })).toBeInTheDocument();
  });
});

describe('W04 page permission panel (AS-54)', () => {
  it('W04 AS-54: a page whose permission is missing shows the panel with the role and a way back, never the content', () => {
    render(
      <PageAccess shop={shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] })} page="api-keys">
        <p>secret keys table</p>
      </PageAccess>,
    );
    expect(screen.getByText("You don't have access to this page.")).toBeInTheDocument();
    expect(screen.getByText(/Viewer/)).toBeInTheDocument();
    expect(screen.getByText('Ask a shop owner or admin to change your role.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', `/dashboard/seller/${SELLER_SHOP_ID}`);
    expect(screen.queryByText('secret keys table')).toBeNull();
  });

  it('W04 AS-54: a page whose permission is held shows its content', () => {
    render(
      <PageAccess shop={shopFixture({ myPermissions: [...ALL_PERMISSIONS] })} page="api-keys">
        <p>keys table</p>
      </PageAccess>,
    );
    expect(screen.getByText('keys table')).toBeInTheDocument();
    expect(screen.queryByText("You don't have access to this page.")).toBeNull();
  });
});
