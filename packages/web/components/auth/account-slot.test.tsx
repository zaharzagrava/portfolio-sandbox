import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSlot, AccountSlotSkeleton, MobileAccountEntries } from './account-slot';

let mockUser: { id: string; email: string; role: string } | null = null;
let mockLoading = false;
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: mockUser, isAuthenticated: !!mockUser, isLoading: mockLoading, logout: vi.fn() }),
}));

describe('W07 account slot stand-in (AS-05, AS-04)', () => {
  beforeEach(() => {
    mockUser = null;
    mockLoading = false;
  });

  it.each([
    ['ADMIN', true],
    ['SELLER', false],
    ['USER', false],
  ])('W07 AS-05: the account menu lists Admin after "Account & security" only for ADMIN (%s -> %s)', async (role, admin) => {
    mockUser = { id: 'u1', email: 'a@example.com', role };
    render(<AccountSlot />);
    await userEvent.click(screen.getByRole('button', { name: /^Account menu/ }));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim());
    expect(items.includes('Admin')).toBe(admin);
    if (admin) {
      expect(items[items.indexOf('Account & security') + 1]).toBe('Admin');
      expect(screen.getByRole('menuitem', { name: 'Admin' })).toHaveAttribute('href', '/admin');
    }
  });

  it.each([
    ['ADMIN', true],
    ['USER', false],
  ])('W07 AS-05: the mobile account group lists Admin only for ADMIN (%s -> %s)', (role, admin) => {
    mockUser = { id: 'u1', email: 'a@example.com', role };
    render(<MobileAccountEntries />);
    const group = screen.getByRole('group', { name: 'Account' });
    expect(within(group).queryByRole('link', { name: 'Admin' }) !== null).toBe(admin);
  });

  it('W07 AS-02: visitors get Log in and Sign up in the mobile entries', () => {
    render(<MobileAccountEntries />);
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['Log in', 'Sign up']);
  });

  it('W07 AS-04: while the session loads the slot is the fixed-size skeleton of the account button', () => {
    mockLoading = true;
    const { container } = render(<AccountSlot />);
    expect(container.querySelector('[data-slot="account-skeleton"]')).not.toBeNull();
    expect(render(<AccountSlotSkeleton />).container.firstElementChild!.className).toContain('size-9');
  });

  it('W07 AS-04: the signed-in account button has the same size as the skeleton (size-9 / icon-lg)', async () => {
    mockUser = { id: 'u1', email: 'a@example.com', role: 'USER' };
    render(<AccountSlot />);
    expect(screen.getByRole('button', { name: /^Account menu/ }).className).toContain('size-9');
  });
});
