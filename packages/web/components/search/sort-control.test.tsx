import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortControl } from '@/components/search/sort-control';

describe('SortControl', () => {
  it('W02 AS-13: with a query it offers Relevance (default), the two price orders and Newest', () => {
    render(<SortControl view={{ q: 'espresso' }} onChange={() => {}} />);
    const select = screen.getByRole('combobox', { name: 'Sort by' });
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Relevance',
      'Price: low to high',
      'Price: high to low',
      'Newest',
    ]);
    expect(select).toHaveValue('');
  });

  it('W02 AS-13: without a query Relevance is hidden and the default reads Featured', () => {
    render(<SortControl view={{}} onChange={() => {}} />);
    const select = screen.getByRole('combobox', { name: 'Sort by' });
    const labels = within(select).getAllByRole('option').map((option) => option.textContent);
    expect(labels).toEqual(['Featured', 'Price: low to high', 'Price: high to low', 'Newest']);
    expect(labels).not.toContain('Relevance');
  });

  it('W02 AS-13: choosing a sort reports it; choosing the default reports none (omitted from the address)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SortControl view={{ q: 'a', sort: 'price-desc' }} onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Sort by' });
    expect(select).toHaveValue('price-desc');
    await user.selectOptions(select, 'newest');
    expect(onChange).toHaveBeenLastCalledWith('newest');
    await user.selectOptions(select, '');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('W02 AS-30: can be disabled', () => {
    render(<SortControl view={{}} onChange={() => {}} disabled />);
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toBeDisabled();
  });
});
