import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { FLAGS_URL, flagFixture } from '@/lib/test/flag-fixtures';
import { navigation, navigationMock, renderAdmin, resetNavigation } from './test-utils';

vi.mock('next/navigation', () => navigationMock());
vi.mock('sonner', () => ({ toast: vi.fn(), Toaster: () => null }));

import { FlagRowActions } from './flag-row-actions';

beforeEach(resetNavigation);

const menuFor = async (status: 'enabled' | 'disabled' | 'killed' | 'archived') => {
  const view = renderAdmin(<FlagRowActions flag={{ key: 'new-checkout', status, offVariant: 'off' }} />);
  const button = screen.getByRole('button', { name: 'Actions for new-checkout' });
  await view.user.click(button);
  const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
  return { ...view, button, items };
};

describe('FlagRowActions', () => {
  it.each([
    ['enabled', ['Open', 'Kill switch']],
    ['disabled', ['Open', 'Kill switch', 'Archive']],
    ['killed', ['Open', 'Restore', 'Archive']],
    ['archived', ['Open']],
  ] as const)('W06 AS-08: a %s flag offers %j', async (status, expected) => {
    expect((await menuFor(status)).items).toEqual(expected);
  });

  it('W06 AS-08: Open goes to the editor', async () => {
    const { user } = await menuFor('enabled');
    await user.click(screen.getByRole('menuitem', { name: 'Open' }));
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith('/admin/feature-flags/new-checkout'));
  });

  it('W06 AS-08: opens with Enter, moves with the arrow keys, Escape closes and returns focus to the menu button', async () => {
    const { user } = renderAdmin(<FlagRowActions flag={{ key: 'new-checkout', status: 'disabled', offVariant: 'off' }} />);
    const button = screen.getByRole('button', { name: 'Actions for new-checkout' });
    button.focus();
    await user.keyboard('{Enter}');
    const first = await screen.findByRole('menuitem', { name: 'Open' });
    await waitFor(() => expect(first).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Kill switch' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(button).toHaveFocus();
  });

  it('W06 AS-08: Kill switch opens the same confirmation as the editor; Cancel returns focus to the menu button', async () => {
    const { user, button } = await menuFor('enabled');
    await user.click(screen.getByRole('menuitem', { name: 'Kill switch' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Kill new-checkout?')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(button).toHaveFocus();
  });

  it('W06 AS-57: Escape closes the dialog and focus returns to the control that opened it', async () => {
    server.use(http.get(`${FLAGS_URL}/new-checkout`, () => HttpResponse.json(flagFixture())));
    const { user, button } = await menuFor('killed');
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(button).toHaveFocus();
  });
});
