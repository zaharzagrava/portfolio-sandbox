import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/utils';
import { OrderLines, OrderSummary, OrderTotals, type SummaryGroup } from './order-summary';

const groups: SummaryGroup[] = [
  {
    id: 'shop-a',
    name: 'Sound Shop',
    lines: [
      { id: 'p1', title: 'Headphones', quantity: 2, lineTotal: { amountMinor: 3998, currency: 'EUR' } },
      { id: 'p2', title: 'Cable', quantity: 1, lineTotal: { amountMinor: 500, currency: 'EUR' }, note: 'Out of stock' },
    ],
  },
  { id: 'other', name: 'Other items', lines: [{ id: 'p3', title: 'Unavailable product', quantity: 1, lineTotal: null, note: 'No longer available' }] },
];

describe('Order summary (W03 FR-041, reused by the pay step)', () => {
  it('W03 AS-15: groups the lines by shop with title, quantity and the line total in the order currency', () => {
    render(<OrderLines groups={groups} />);
    const shop = screen.getByRole('region', { name: 'Sound Shop' });
    const items = within(shop).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Headphones');
    expect(items[0]).toHaveTextContent('Quantity 2');
    expect(items[0]).toHaveTextContent(formatMoney(3998, 'EUR'));
    expect(screen.getByRole('region', { name: 'Other items' })).toBeInTheDocument();
  });

  it('W03 AS-08: a line note is shown and a line without a price shows a dash', () => {
    render(<OrderLines groups={groups} />);
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
    const gone = screen.getByText('Unavailable product').closest('li') as HTMLElement;
    expect(gone).toHaveTextContent('No longer available');
    expect(gone).toHaveTextContent('—');
  });

  it('W03 AS-15: the total carries its label and the formatted amount with the currency', () => {
    render(<OrderTotals totals={[{ amountMinor: 4498, currency: 'EUR' }]} />);
    expect(screen.getByText('Estimated total')).toBeInTheDocument();
    expect(screen.getByText(formatMoney(4498, 'EUR'))).toBeInTheDocument();
  });

  it('W03 AS-35: the label can be changed (the pay page says Total) and several currencies list one amount each', () => {
    render(<OrderTotals label="Total" totals={[{ amountMinor: 100, currency: 'EUR' }, { amountMinor: 200, currency: 'USD' }]} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText(formatMoney(100, 'EUR'))).toBeInTheDocument();
    expect(screen.getByText(formatMoney(200, 'USD'))).toBeInTheDocument();
  });

  it('W03 AS-35: OrderSummary renders the lines and the total together', () => {
    render(<OrderSummary groups={groups} totals={[{ amountMinor: 4498, currency: 'EUR' }]} totalLabel="Total" />);
    expect(screen.getByText('Headphones')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });
});
