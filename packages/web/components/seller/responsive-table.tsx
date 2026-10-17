import type { ReactNode } from 'react';
import { cn } from 'cn';

export type Column<Row> = {
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
  /** The row's main value: it is the row header (`th scope="row"`) and the heading of the card on a phone. */
  primary?: boolean;
  className?: string;
};

/**
 * One table for both layouts (W04 R-16, AS-95, AS-97). From 641 px up it is a table; at 640 px and below CSS turns each row
 * into a card: the primary value as its heading, the other cells as "label: value" pairs (the label comes from `data-label`),
 * the actions at the end. The same DOM serves both, so a screen reader and a test see one list. `busy` keeps the rows and
 * dims them while the next ones load (AS-31). Seller text is rendered as text.
 */
export function ResponsiveTable<Row>({
  caption,
  captionHidden = false,
  columns,
  rows,
  rowKey,
  actions,
  busy = false,
  className,
  rowTestId,
}: {
  caption: string;
  /** The page heading already says it: keep the caption for assistive technology only. */
  captionHidden?: boolean;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** The cell of the last column (usually a `RowMenu`). */
  actions?: (row: Row) => ReactNode;
  busy?: boolean;
  className?: string;
  /** `data-testid` of each row (the browser journeys count rows). */
  rowTestId?: string;
}) {
  return (
    <div className={cn('w-full', className)}>
      <table aria-busy={busy} className={cn('w-full text-sm max-sm:block', busy && 'opacity-60 transition-opacity')}>
        <caption className={cn('text-left text-sm font-medium', captionHidden ? 'sr-only' : 'mb-2')}>{caption}</caption>
        <thead className="max-sm:sr-only">
          <tr className="border-b text-left max-sm:block">
            {columns.map((column) => (
              <th key={column.id} scope="col" className="h-10 px-2 align-middle font-medium whitespace-nowrap text-muted-foreground max-sm:sr-only">
                {column.header}
              </th>
            ))}
            {actions && (
              <th scope="col" className="h-10 w-12 px-2 text-right align-middle max-sm:sr-only">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="max-sm:block max-sm:space-y-3">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              data-testid={rowTestId}
              className="border-b align-top max-sm:relative max-sm:block max-sm:rounded-lg max-sm:border max-sm:p-3 max-sm:pr-12"
            >
              {columns.map((column) =>
                column.primary ? (
                  <th key={column.id} scope="row" className={cn('px-2 py-2 text-left font-medium break-words max-sm:block max-sm:px-0 max-sm:text-base', column.className)}>
                    {column.cell(row)}
                  </th>
                ) : (
                  <td
                    key={column.id}
                    data-label={column.header}
                    className={cn(
                      'px-2 py-2 break-words max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:px-0 max-sm:py-1 max-sm:before:shrink-0 max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]',
                      column.className,
                    )}
                  >
                    <span className="max-sm:text-right">{column.cell(row)}</span>
                  </td>
                ),
              )}
              {actions && <td className="px-2 py-1 text-right max-sm:absolute max-sm:top-1 max-sm:right-1 max-sm:p-0">{actions(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
