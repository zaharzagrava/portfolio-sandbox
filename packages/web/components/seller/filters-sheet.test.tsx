import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FiltersSheet } from './filters-sheet';

describe('W04 FiltersSheet', () => {
  it('W04 AS-97: a Filters button opens a sheet holding the filters, and Done closes it', async () => {
    const user = userEvent.setup();
    render(
      <FiltersSheet>
        <label>
          Stock
          <select>
            <option>All</option>
          </select>
        </label>
      </FiltersSheet>,
    );
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).getByLabelText('Stock')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('W04 AS-97: the inline copy for wide screens is hidden from assistive technology while the sheet is open, so no field exists twice', async () => {
    const user = userEvent.setup();
    render(
      <FiltersSheet>
        <input aria-label="Search" />
      </FiltersSheet>,
    );
    expect(screen.getAllByLabelText('Search')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await screen.findByRole('dialog');
    expect(screen.getAllByLabelText('Search', { selector: 'input' })).toHaveLength(2);
    const inline = document.querySelector('[data-filters-inline]');
    expect(inline).toHaveAttribute('inert');
  });

  it('W04 AS-97: the button says how many filters are on, and Clear filters runs the caller\'s reset', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <FiltersSheet activeCount={2} onClear={onClear}>
        <input aria-label="Search" />
      </FiltersSheet>,
    );
    expect(screen.getByRole('button', { name: 'Filters (2 on)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filters (2 on)' }));
    await user.click(await screen.findByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('W04 AS-94: Escape closes the sheet and focus returns to the Filters button', async () => {
    const user = userEvent.setup();
    render(
      <FiltersSheet>
        <input aria-label="Search" />
      </FiltersSheet>,
    );
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Filters' })).toHaveFocus());
  });
});
