import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const session = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('@/lib/auth/session.server', () => ({ getServerSession: async () => session.user }));

import { AccountSlot, AccountSlotSkeleton, MobileAccountEntries } from './account-slot';

const mount = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe('W01 account slot (server part, AS-18)', () => {
  beforeEach(() => {
    session.user = null;
  });

  it('W01 AS-18: the placeholder has the account button size, aria-busy and announces no text', () => {
    const { container } = render(<AccountSlotSkeleton />);
    const skeleton = container.firstElementChild!;
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveAttribute('data-slot', 'account-skeleton');
    expect(skeleton.className).toContain('size-9');
    expect(skeleton).toHaveTextContent('');
  });

  it('W01 AS-18: the server component hands the client leaf only {id, email, role}', async () => {
    session.user = { id: 'u1', email: 'a@example.com', role: 'SELLER', passwordHash: 'secret', extra: 1 };
    const element = await AccountSlot();
    expect(isValidElement(element)).toBe(true);
    expect((element as { props: { initialUser: unknown } }).props.initialUser).toEqual({ id: 'u1', email: 'a@example.com', role: 'SELLER' });
  });

  it('W01 AS-18: a signed-in member resolves to the account menu without ever rendering Log in or Sign up', async () => {
    session.user = { id: 'u1', email: 'a@example.com', role: 'USER' };
    mount(await AccountSlot());
    expect(screen.getByRole('button', { name: 'Account menu' })).toHaveTextContent('A');
    expect(screen.queryByRole('link', { name: /Log in|Sign up/ })).not.toBeInTheDocument();
  });

  it('W01 AS-17: a visitor resolves to Log in and Sign up links', async () => {
    mount(await AccountSlot());
    expect(screen.getByRole('link', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign up' })).toBeInTheDocument();
  });

  it('W01 AS-17: the slot module still exports MobileAccountEntries for the mobile menu contract', () => {
    expect(typeof MobileAccountEntries).toBe('function');
  });
});
