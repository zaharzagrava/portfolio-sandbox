import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminAccess, adminReturnTo } from '@/lib/admin/access';

const session = vi.hoisted(() => ({ getServerSession: vi.fn(), requireServerSession: vi.fn() }));
vi.mock('@/lib/auth/session.server', () => session);
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  usePathname: () => '/admin/feature-flags',
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({ ...(await importOriginal<typeof import('@tanstack/react-query')>()), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

import { AdminGuard, requireAdminPage } from './admin-guard';

const admin = { id: 'a1', email: 'admin@marketplace.local', role: 'ADMIN' as const };
const member = { id: 'm1', email: 'member@example.com', role: 'USER' as const };

beforeEach(() => vi.resetAllMocks());

describe('adminAccess', () => {
  it('W06 AS-47: anonymous → sign in with returnTo = path and query', () => {
    expect(adminAccess(null, adminReturnTo('/admin/feature-flags', { status: 'killed', cursor: 'c1' }))).toEqual({
      kind: 'redirect',
      to: '/login?returnTo=%2Fadmin%2Ffeature-flags%3Fstatus%3Dkilled%26cursor%3Dc1',
    });
  });

  it('W06 AS-48: a member is forbidden, an admin is ok', () => {
    expect(adminAccess(member, '/admin/feature-flags').kind).toBe('forbidden');
    expect(adminAccess(admin, '/admin/feature-flags').kind).toBe('ok');
  });

  it('W06 AS-47: repeated query parameters stay repeated', () => {
    expect(adminReturnTo('/admin/feature-flags', { status: ['a', 'b'] })).toBe('/admin/feature-flags?status=a&status=b');
  });
});

describe('AdminGuard', () => {
  it('W06 AS-48: a member sees only the no-access panel with a way back, and no navigation', async () => {
    session.getServerSession.mockResolvedValue(member);
    render(await AdminGuard({ children: <p>flag data</p> }));
    expect(screen.getByRole('heading', { level: 1, name: "You don't have access to this area." })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to marketplace' })).toHaveAttribute('href', '/');
    // The page is rendered for the framework's instant-navigation check, but hidden (and it requests nothing).
    expect(screen.getByText('flag data')).not.toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('W06 AS-59: an admin gets the shell around the page', async () => {
    session.getServerSession.mockResolvedValue(admin);
    render(await AdminGuard({ children: <p>flag data</p> }));
    expect(screen.getByText('flag data')).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Admin' }).length).toBeGreaterThan(0);
    expect(screen.getByText('admin@marketplace.local')).toBeInTheDocument();
  });

  it('W06 AS-66: an anonymous visitor gets the page bare, without any navigation (the page redirects itself)', async () => {
    session.getServerSession.mockResolvedValue(null);
    render(await AdminGuard({ children: <p>page</p> }));
    expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument();
  });
});

describe('requireAdminPage', () => {
  it('W06 AS-47: anonymous is redirected before anything else runs', async () => {
    session.requireServerSession.mockImplementation(async (returnTo: string) => {
      throw new Error(`NEXT_REDIRECT:/login?returnTo=${encodeURIComponent(returnTo)}`);
    });
    await expect(requireAdminPage('/admin/feature-flags?tab=stale')).rejects.toThrow('NEXT_REDIRECT:/login?returnTo=%2Fadmin%2Ffeature-flags%3Ftab%3Dstale');
  });

  it('W06 AS-48: a member is not an admin page viewer, an admin is', async () => {
    session.requireServerSession.mockResolvedValueOnce(member);
    expect(await requireAdminPage('/admin/feature-flags')).toBe(false);
    session.requireServerSession.mockResolvedValueOnce(admin);
    expect(await requireAdminPage('/admin/feature-flags')).toBe(true);
  });
});
