import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileMenu } from './mobile-menu';

let mockPathname = '/';
let mockAuthenticated = false;
let mockCount: number | undefined;
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ isAuthenticated: mockAuthenticated }) }));
vi.mock('@/components/cart/cart-badge', () => ({
  useCartCount: () => mockCount ?? null,
}));
vi.mock('@/components/auth/account-menu', () => ({
  MobileAccountEntries: () => <div data-testid="account-entries">account</div>,
  MobileLoginLink: () => null,
}));
vi.mock('@/components/chat/assistant-launcher', () => ({
  AssistantLauncher: ({ variant }: { variant: string }) => <button type="button">AI Assistant ({variant})</button>,
}));

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  return screen.getByRole('dialog', { name: 'Menu' });
};

describe('W07 mobile menu (AS-02)', () => {
  beforeEach(() => {
    mockPathname = '/';
    mockAuthenticated = false;
    mockCount = undefined;
  });

  it('W07 AS-02: the hamburger is named "Open menu" and announces its expanded state', async () => {
    render(<MobileMenu />);
    const button = screen.getByRole('button', { name: 'Open menu' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('W07 AS-02: a modal sheet titled "Menu" lists the account entries first, then the "Main" navigation in order', async () => {
    mockAuthenticated = true;
    mockCount = 3;
    render(<MobileMenu />);
    const dialog = await open();
    const nav = within(dialog).getByRole('navigation', { name: 'Main' });
    expect(dialog.querySelector('[data-testid="account-entries"]')).not.toBeNull();
    // account entries come before the navigation
    expect(dialog.querySelector('[data-testid="account-entries"]')!.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Browse', 'Cart (3)', 'Chats', 'Developers']);
    expect(within(nav).getByRole('button', { name: 'AI Assistant (menu-item)' })).toBeInTheDocument();
    // the assistant item is last
    const items = within(nav).getAllByRole('listitem');
    expect(items[items.length - 1]).toHaveTextContent('AI Assistant');
  });

  it('W07 AS-02: visitors get no Chats entry; the cart has no count until known', async () => {
    render(<MobileMenu />);
    const nav = within(await open()).getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Browse', 'Cart', 'Developers']);
  });

  it('W07 AS-02: links point at the right places', async () => {
    mockAuthenticated = true;
    render(<MobileMenu />);
    const nav = within(await open()).getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Browse' })).toHaveAttribute('href', '/search');
    expect(within(nav).getByRole('link', { name: 'Cart' })).toHaveAttribute('href', '/cart');
    expect(within(nav).getByRole('link', { name: 'Chats' })).toHaveAttribute('href', '/chat');
    expect(within(nav).getByRole('link', { name: 'Developers' })).toHaveAttribute('href', '/developers/docs');
  });

  it('W07 AS-02: focus moves into the sheet and returns to the hamburger on Escape', async () => {
    render(<MobileMenu />);
    const dialog = await open();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
  });

  it('W07 AS-02: choosing a link closes the sheet', async () => {
    render(<MobileMenu />);
    const nav = within(await open()).getByRole('navigation', { name: 'Main' });
    await userEvent.click(within(nav).getByRole('link', { name: 'Browse' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('W07 AS-02: choosing AI Assistant closes the sheet', async () => {
    render(<MobileMenu />);
    const nav = within(await open()).getByRole('navigation', { name: 'Main' });
    await userEvent.click(within(nav).getByRole('button', { name: /AI Assistant/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('W07 AS-02: a route change by any other means (Back) closes the sheet', async () => {
    const { rerender } = render(<MobileMenu />);
    await open();
    mockPathname = '/privacy';
    rerender(<MobileMenu />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
