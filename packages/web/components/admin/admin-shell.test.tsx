import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/query-keys';

let pathname = '/admin/feature-flags';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { AdminShell } from './admin-shell';

const renderShell = (client = new QueryClient()) =>
  render(
    <QueryClientProvider client={client}>
      <AdminShell viewerEmail="admin@marketplace.local">
        <h1>Feature flags</h1>
      </AdminShell>
    </QueryClientProvider>,
  );

afterEach(() => {
  pathname = '/admin/feature-flags';
  vi.restoreAllMocks();
});

describe('AdminShell', () => {
  it('W06 AS-59: header with brand, "Back to marketplace" and the viewer e-mail; navigation named Admin with the current entry marked', () => {
    renderShell();
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'Marketplace Admin' })).toHaveAttribute('href', '/admin');
    expect(within(header).getByRole('link', { name: 'Back to marketplace' })).toHaveAttribute('href', '/');
    expect(within(header).getByText('admin@marketplace.local')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(nav).getByRole('link', { name: 'Feature flags' })).toHaveAttribute('aria-current', 'page');
  });

  it('W06 AS-59: the current entry stays marked on a deeper page', () => {
    pathname = '/admin/feature-flags/new-checkout';
    renderShell();
    expect(screen.getByRole('link', { name: 'Feature flags' })).toHaveAttribute('aria-current', 'page');
  });

  it('W06 AS-59: the drawer opens with "Open menu", closes after a choice, and focus returns to the button', async () => {
    const user = userEvent.setup();
    renderShell();
    const open = screen.getByRole('button', { name: 'Open menu' });
    await user.click(open);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('link', { name: 'Feature flags' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it('W06 AS-57: Escape closes the drawer and returns focus to "Open menu"', async () => {
    const user = userEvent.setup();
    renderShell();
    const open = screen.getByRole('button', { name: 'Open menu' });
    await user.click(open);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it('W06 AS-52: offline shows the banner; coming back clears it and refetches the console queries once', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderShell(client);
    expect(screen.queryByText("You're offline. Changes can't be saved.")).not.toBeInTheDocument();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(await screen.findByText("You're offline. Changes can't be saved.")).toBeInTheDocument();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    expect(screen.queryByText("You're offline. Changes can't be saved.")).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.admin.flags.all });
  });
});
