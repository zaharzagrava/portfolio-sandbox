import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResponsiveTable, type Column } from './responsive-table';

type Row = { id: string; name: string; price: string; stock: number };
const rows: Row[] = [
  { id: 'a', name: 'Handmade Ceramic Mug', price: '€24.50', stock: 12 },
  { id: 'b', name: '<img src=x onerror=alert(1)>', price: '€1.00', stock: 0 },
];
const columns: Column<Row>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.name, primary: true },
  { id: 'price', header: 'Price', cell: (row) => row.price },
  { id: 'stock', header: 'Stock', cell: (row) => String(row.stock) },
];

describe('W04 ResponsiveTable', () => {
  it('W04 AS-95: a real table with a caption, column headers with scope=col and a row header per row', () => {
    render(<ResponsiveTable caption="Products of Clay Works" columns={columns} rows={rows} rowKey={(row) => row.id} />);
    const table = screen.getByRole('table', { name: 'Products of Clay Works' });
    expect(within(table).getAllByRole('columnheader').map((th) => [th.textContent, th.getAttribute('scope')])).toEqual([
      ['Name', 'col'],
      ['Price', 'col'],
      ['Stock', 'col'],
    ]);
    const rowHeaders = within(table).getAllByRole('rowheader');
    expect(rowHeaders.map((th) => th.textContent)).toEqual(['Handmade Ceramic Mug', '<img src=x onerror=alert(1)>']);
    expect(rowHeaders.every((th) => th.getAttribute('scope') === 'row')).toBe(true);
  });

  it('W04 AS-43: seller text is rendered as text and nothing executes', () => {
    render(<ResponsiveTable caption="Products" columns={columns} rows={rows} rowKey={(row) => row.id} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('W04 AS-97: one DOM for both layouts: every cell carries its column label for the card layout', () => {
    render(<ResponsiveTable caption="Products" columns={columns} rows={rows} rowKey={(row) => row.id} />);
    expect(screen.getAllByRole('table')).toHaveLength(1);
    const cells = screen.getAllByRole('cell').filter((cell) => cell.getAttribute('data-label'));
    expect(cells.map((cell) => cell.getAttribute('data-label'))).toEqual(['Price', 'Stock', 'Price', 'Stock']);
  });

  it('W04 AS-95: a hidden caption is still the table name (visually hidden, not removed)', () => {
    render(<ResponsiveTable caption="Webhook endpoints" captionHidden columns={columns} rows={rows} rowKey={(row) => row.id} />);
    expect(screen.getByRole('table', { name: 'Webhook endpoints' })).toBeInTheDocument();
    expect(document.querySelector('caption')).toHaveClass('sr-only');
  });

  it('W04 AS-97: actions go in the last column, headed for screen readers only', () => {
    render(<ResponsiveTable caption="Products" columns={columns} rows={rows} rowKey={(row) => row.id} actions={(row) => <button>Actions for {row.name}</button>} />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers.at(-1)).toHaveTextContent('Actions');
    expect(within(headers.at(-1) as HTMLElement).getByText('Actions')).toHaveClass('sr-only');
    expect(screen.getByRole('button', { name: 'Actions for Handmade Ceramic Mug' })).toBeInTheDocument();
  });

  it('W04 AS-31: busy keeps the rows, dims them and sets aria-busy', () => {
    const { rerender } = render(<ResponsiveTable caption="Products" columns={columns} rows={rows} rowKey={(row) => row.id} />);
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false');
    rerender(<ResponsiveTable caption="Products" columns={columns} rows={rows} rowKey={(row) => row.id} busy />);
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('W04 FR-010: rows keep their DOM node when the order changes (stable keys)', () => {
    const { rerender } = render(<ResponsiveTable caption="Products" columns={columns} rows={rows} rowKey={(row) => row.id} />);
    const first = screen.getByText('Handmade Ceramic Mug').closest('tr');
    rerender(<ResponsiveTable caption="Products" columns={columns} rows={[...rows].reverse()} rowKey={(row) => row.id} />);
    expect(screen.getByText('Handmade Ceramic Mug').closest('tr')).toBe(first);
  });
});
