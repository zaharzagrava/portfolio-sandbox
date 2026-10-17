import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyInventoryTarget, switchShopHref } from '@/lib/seller/nav';
import { shopListItemFixture } from '@/lib/test/seller-handlers';
import { ShopSwitcher } from './shop-switcher';

let mockPathname = '/dashboard/seller/11111111-1111-4111-8111-111111111111/inventory';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const shops = [
  shopListItemFixture({ id: A, name: 'Clay Works', slug: 'clay-works', role: 'OWNER' }),
  shopListItemFixture({ id: B, name: 'Wood Shop', slug: 'wood-shop', role: 'VIEWER', status: 'SUSPENDED' }),
  shopListItemFixture({ id: C, name: 'Glass Art', slug: 'glass-art', role: 'ADMIN', status: 'DELETING' }),
];

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: /Clay Works/ }));
  return screen.getByRole('list', { name: 'Your shops' });
};

beforeEach(() => {
  mockPathname = `/dashboard/seller/${A}/inventory`;
});

describe('W04 shop switcher (AS-09)', () => {
  it('W04 AS-09: the closed switcher names the current shop and the open list shows name, handle, role and a badge when not active', async () => {
    render(<ShopSwitcher shops={shops} currentShopId={A} />);
    const trigger = screen.getByRole('button', { name: /Clay Works/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const list = await open();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Clay Works');
    expect(rows[0]).toHaveTextContent('clay-works');
    expect(rows[0]).toHaveTextContent('Owner');
    expect(within(rows[0]!).queryByText(/suspended|closing/i)).toBeNull();
    expect(rows[1]).toHaveTextContent('Viewer');
    expect(rows[1]).toHaveTextContent('Suspended');
    expect(rows[2]).toHaveTextContent('Admin');
    expect(rows[2]).toHaveTextContent('Closing');
  });

  it('W04 AS-09: the current shop is marked in words and with aria-current; the others are not', async () => {
    render(<ShopSwitcher shops={shops} currentShopId={B} />);
    await userEvent.click(screen.getByRole('button', { name: /Wood Shop/ }));
    const current = screen.getByRole('link', { name: /Wood Shop/ });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current).toHaveTextContent('Current');
    expect(screen.getByRole('link', { name: /Clay Works/ })).not.toHaveAttribute('aria-current');
  });

  it('W04 AS-09: choosing another shop goes to the same section of that shop', async () => {
    render(<ShopSwitcher shops={shops} currentShopId={A} />);
    await open();
    expect(screen.getByRole('link', { name: /Wood Shop/ })).toHaveAttribute('href', `/dashboard/seller/${B}/inventory`);
    expect(screen.getByRole('link', { name: /Glass Art/ })).toHaveAttribute('href', `/dashboard/seller/${C}/inventory`);
  });

  it.each([
    [`/dashboard/seller/${A}`, `/dashboard/seller/${B}`],
    [`/dashboard/seller/${A}/orders`, `/dashboard/seller/${B}/orders`],
    [`/dashboard/seller/${A}/team`, `/dashboard/seller/${B}/team`],
    [`/dashboard/seller/${A}/developers/webhooks`, `/dashboard/seller/${B}/developers/webhooks`],
    [`/dashboard/seller/${A}/developers/webhooks/ep-1`, `/dashboard/seller/${B}/developers/webhooks`],
    [`/dashboard/seller/${A}/inventory/prod-1`, `/dashboard/seller/${B}/inventory`],
    ['/dashboard/seller', `/dashboard/seller/${B}`],
  ])('W04 AS-09: from %s the switcher goes to %s', (from, to) => {
    expect(switchShopHref(from, A, B)).toBe(to);
  });

  it('W04 AS-09: it lists the first 50 shops it is given and links to the picker for more, with the cursor when there is one', async () => {
    const many = Array.from({ length: 60 }, (_, i) => shopListItemFixture({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Shop ${i}`, slug: `shop-${i}` }));
    render(<ShopSwitcher shops={[shopListItemFixture({ id: A, name: 'Clay Works' }), ...many]} currentShopId={A} nextCursor="abc 1" />);
    await open();
    const list = screen.getByRole('list', { name: 'Your shops' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', '/dashboard/seller?cursor=abc%201');
  });

  it('W04 AS-09: with every shop shown there is still a way to the picker, without a cursor', async () => {
    render(<ShopSwitcher shops={shops} currentShopId={A} />);
    await open();
    expect(screen.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', '/dashboard/seller');
  });

  it('W04 AS-09: Escape closes the list and gives focus back to the switcher button', async () => {
    render(<ShopSwitcher shops={shops} currentShopId={A} />);
    await open();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('list', { name: 'Your shops' })).toBeNull();
    expect(screen.getByRole('button', { name: /Clay Works/ })).toHaveFocus();
  });

  it('W04 AS-09: choosing a shop closes the list and tells the drawer (onNavigate)', async () => {
    const onNavigate = vi.fn();
    render(<ShopSwitcher shops={shops} currentShopId={A} onNavigate={onNavigate} />);
    await open();
    await userEvent.click(screen.getByRole('link', { name: /Wood Shop/ }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('list', { name: 'Your shops' })).toBeNull();
  });
});

describe('W04 legacy inventory redirect (AS-08)', () => {
  it('W04 AS-08: one shop goes to that shop\'s inventory', () => {
    expect(legacyInventoryTarget([{ id: A }])).toBe(`/dashboard/seller/${A}/inventory`);
  });

  it.each([[[]], [[{ id: A }, { id: B }]]])('W04 AS-08: no shop or several go to the picker (%j)', (list) => {
    expect(legacyInventoryTarget(list)).toBe('/dashboard/seller');
  });
});
