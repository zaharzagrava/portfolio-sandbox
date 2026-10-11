import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SearchFacets } from '@marketplace-sandbox/contracts';
import { FilterPanel } from '@/components/search/filter-panel';
import { FilterChips } from '@/components/search/filter-chips';

const facets: SearchFacets = {
  categories: [
    { key: 'home-living', count: 12 },
    { key: 'phones', count: 3 },
  ],
  brands: [
    { key: 'Acme', count: 7 },
    { key: 'apple', count: 2 },
  ],
  priceRanges: [
    { key: 'under_25', count: 4 },
    { key: '25_to_50', count: 5 },
    { key: '50_to_100', count: 0 },
    { key: 'over_100', count: 1 },
  ],
  avgRating: 4.27,
};

function setup(props: Partial<Parameters<typeof FilterPanel>[0]> = {}) {
  const onChange = vi.fn();
  const onClearAll = vi.fn();
  render(<FilterPanel view={{ q: 'a' }} facets={facets} currency="USD" onChange={onChange} onClearAll={onClearAll} {...props} />);
  return { onChange, onClearAll, user: userEvent.setup() };
}

describe('FilterPanel', () => {
  it('W02 AS-27: is a form landmark named Filters', () => {
    setup();
    expect(screen.getByRole('form', { name: 'Filters' })).toBeInTheDocument();
  });

  it('W02 AS-14: shows the counts as the API gave them, keys as labels', () => {
    setup();
    const category = screen.getByRole('group', { name: 'Category' });
    expect(within(category).getAllByRole('button').map((b) => b.textContent)).toEqual(['Home living12', 'Phones3']);
    expect(within(category).getByRole('button', { name: 'Home living (12)' })).toBeInTheDocument();
    const brand = screen.getByRole('group', { name: 'Brand' });
    expect(within(brand).getByRole('button', { name: 'Acme (7)' })).toBeInTheDocument();
    expect(within(brand).getByRole('button', { name: 'Apple (2)' })).toBeInTheDocument();
  });

  it('W02 AS-14: shows at most 20 category values', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ key: `c-${i}`, count: 1 }));
    setup({ facets: { ...facets, categories: many } });
    expect(within(screen.getByRole('group', { name: 'Category' })).getAllByRole('button')).toHaveLength(20);
  });

  it('W02 AS-14: choosing a value sends its exact key; the selected one is pressed and choosing it again clears it', async () => {
    const { onChange, user } = setup({ view: { q: 'a', category: 'phones' } });
    const category = screen.getByRole('group', { name: 'Category' });
    expect(within(category).getByRole('button', { name: 'Phones (3)' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(category).getByRole('button', { name: 'Home living (12)' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(category).getByRole('button', { name: 'Home living (12)' }));
    expect(onChange).toHaveBeenLastCalledWith({ category: 'home-living' });
    await user.click(within(category).getByRole('button', { name: 'Phones (3)' }));
    expect(onChange).toHaveBeenLastCalledWith({ category: undefined });
  });

  it('W02 AS-14: a group without values is not rendered', () => {
    setup({ facets: { ...facets, brands: [], avgRating: null } });
    expect(screen.queryByRole('group', { name: 'Brand' })).toBeNull();
    expect(screen.queryByText(/Average rating/)).toBeNull();
  });

  it('W02 AS-14: no facets at all renders only the plain filters', () => {
    setup({ facets: undefined });
    expect(screen.queryByRole('group', { name: 'Category' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Rating' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'In stock only' })).toBeInTheDocument();
  });

  it('W02 AS-14: the average rating is shown to one decimal', () => {
    setup();
    expect(screen.getByText('Average rating 4.3')).toBeInTheDocument();
  });

  it('W02 AS-14: the four price bands follow the response currency', () => {
    setup({ currency: 'EUR' });
    const price = screen.getByRole('group', { name: 'Price' });
    for (const label of ['Under €25', '€25 to €50', '€50 to €100', 'Over €100']) {
      expect(within(price).getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('W02 AS-16: a band fills both fields and applies', async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('button', { name: /^\$25 to \$50/ }));
    expect(screen.getByLabelText('Minimum price')).toHaveValue('25');
    expect(screen.getByLabelText('Maximum price')).toHaveValue('50');
    expect(onChange).toHaveBeenLastCalledWith({ minPriceMinor: 2500, maxPriceMinor: 5000 });
  });

  it('W02 AS-16: Apply writes minor units from major-unit fields', async () => {
    const { onChange, user } = setup();
    await user.type(screen.getByLabelText('Minimum price'), '10');
    await user.type(screen.getByLabelText('Maximum price'), '500.50');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenLastCalledWith({ minPriceMinor: 1000, maxPriceMinor: 50050 });
  });

  it('W02 AS-16: Enter in a field applies', async () => {
    const { onChange, user } = setup();
    await user.type(screen.getByLabelText('Maximum price'), '30{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ minPriceMinor: undefined, maxPriceMinor: 3000 });
  });

  it('W02 AS-16: minimum above maximum shows the message and sends nothing', async () => {
    const { onChange, user } = setup();
    await user.type(screen.getByLabelText('Minimum price'), '50');
    await user.type(screen.getByLabelText('Maximum price'), '10');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText("The minimum price can't be higher than the maximum.")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['abc', '-5', '1.234', '1,5'])('W02 AS-16: "%s" shows the format message and sends nothing', async (text) => {
    const { onChange, user } = setup();
    await user.type(screen.getByLabelText('Minimum price'), text);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('Enter a price like 25 or 25.50.')).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum price')).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('W02 AS-16: empty fields remove the bounds', async () => {
    const { onChange, user } = setup({ view: { q: 'a', minPriceMinor: 1000, maxPriceMinor: 5000 } });
    expect(screen.getByLabelText('Minimum price')).toHaveValue('10');
    await user.clear(screen.getByLabelText('Minimum price'));
    await user.clear(screen.getByLabelText('Maximum price'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenLastCalledWith({ minPriceMinor: undefined, maxPriceMinor: undefined });
  });

  it('W02 AS-17: rating choices set minRating and the active one clears it', async () => {
    const { onChange, user } = setup({ view: { q: 'a', minRating: 3 } });
    const rating = screen.getByRole('group', { name: 'Rating' });
    expect(within(rating).getAllByRole('button').map((b) => b.textContent)).toEqual(['4 stars & up', '3 stars & up', '2 stars & up', '1 star & up']);
    await user.click(within(rating).getByRole('button', { name: '4 stars & up' }));
    expect(onChange).toHaveBeenLastCalledWith({ minRating: 4 });
    expect(within(rating).getByRole('button', { name: '3 stars & up' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(rating).getByRole('button', { name: '3 stars & up' }));
    expect(onChange).toHaveBeenLastCalledWith({ minRating: undefined });
  });

  it('W02 AS-17: In stock only is a switch that sets inStock=true and clears it', async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('switch', { name: 'In stock only' }));
    expect(onChange).toHaveBeenLastCalledWith({ inStock: true });
  });

  it('W02 AS-17: an active In stock only switch clears the filter', async () => {
    const { onChange, user } = setup({ view: { q: 'a', inStock: true } });
    const toggle = screen.getByRole('switch', { name: 'In stock only' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({ inStock: undefined });
  });

  it('W02 AS-21: meaning search hides the category and brand lists with the note and keeps the plain filters', () => {
    setup({ view: { q: 'a', semantic: true } });
    expect(screen.queryByRole('group', { name: 'Category' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Brand' })).toBeNull();
    expect(screen.getByText("Counts aren't available for meaning search.")).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Rating' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'In stock only' })).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum price')).toBeInTheDocument();
  });

  it('W02 AS-30: disabled controls keep their values and show the note', () => {
    setup({ view: { q: 'a', category: 'phones', minPriceMinor: 1000 }, disabled: true });
    expect(screen.getByText('Not available together with pickup search.')).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum price')).toBeDisabled();
    expect(screen.getByLabelText('Minimum price')).toHaveValue('10');
    expect(screen.getByRole('switch', { name: 'In stock only' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Phones (3)' })).toBeDisabled();
  });

  it('W02 AS-27: every control is operable by keyboard', async () => {
    const { onChange, user } = setup();
    const target = screen.getByRole('button', { name: 'Phones (3)' });
    await user.tab();
    let guard = 0;
    while (document.activeElement !== target && guard++ < 30) await user.tab();
    expect(target).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ category: 'phones' });
    screen.getByRole('switch', { name: 'In stock only' }).focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith({ inStock: true });
    screen.getByRole('button', { name: '2 stars & up' }).focus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ minRating: 2 });
  });
});

describe('FilterChips', () => {
  const view = { q: 'a', category: 'shoes', brand: 'Acme', minPriceMinor: 1000, maxPriceMinor: 5000, minRating: 4, inStock: true as const, sort: 'newest' as const };

  it('W02 AS-15: each active filter is a chip with the name of its remove button', () => {
    render(<FilterChips view={view} currency="USD" onRemove={() => {}} onClearAll={() => {}} />);
    for (const name of [
      'Remove filter Category: shoes',
      'Remove filter Brand: Acme',
      'Remove filter Price: $10 – $50',
      'Remove filter 4 stars & up',
      'Remove filter In stock',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('W02 AS-15: removing a chip reports what to clear (a price chip clears both bounds)', async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<FilterChips view={view} currency="USD" onRemove={onRemove} onClearAll={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Remove filter Price: $10 – $50' }));
    expect(onRemove).toHaveBeenLastCalledWith({ minPriceMinor: undefined, maxPriceMinor: undefined });
    await user.click(screen.getByRole('button', { name: 'Remove filter Category: shoes' }));
    expect(onRemove).toHaveBeenLastCalledWith({ category: undefined });
  });

  it('W02 AS-15: one-sided prices have their own wording', () => {
    const { rerender } = render(<FilterChips view={{ minPriceMinor: 1000 }} currency="USD" onRemove={() => {}} onClearAll={() => {}} />);
    expect(screen.getByRole('button', { name: 'Remove filter Price: from $10' })).toBeInTheDocument();
    rerender(<FilterChips view={{ maxPriceMinor: 5000 }} currency="USD" onRemove={() => {}} onClearAll={() => {}} />);
    expect(screen.getByRole('button', { name: 'Remove filter Price: up to $50' })).toBeInTheDocument();
  });

  it('W02 AS-15: Clear all filters is offered with filters on, and not otherwise', async () => {
    const onClearAll = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<FilterChips view={view} currency="USD" onRemove={() => {}} onClearAll={onClearAll} />);
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    rerender(<FilterChips view={{ q: 'a', sort: 'newest' }} currency="USD" onRemove={() => {}} onClearAll={onClearAll} />);
    expect(screen.queryByRole('button', { name: 'Clear all filters' })).toBeNull();
  });
});
