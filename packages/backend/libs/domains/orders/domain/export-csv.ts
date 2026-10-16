import type { ExportRow } from './export-row';

/**
 * CSV encoding of the order export (S12 AS-13, AS-14, FR-011, FR-012). Pure: bytes depend on the input only.
 * Money columns arrive as decimal strings and are written verbatim.
 */
export const CSV_BOM = '﻿';
export const CSV_EOL = '\r\n';

export const EXPORT_COLUMNS = [
  'order_id',
  'shop_order_id',
  'created_at',
  'shop_order_status',
  'currency',
  'product_id',
  'sku',
  'title',
  'quantity',
  'unit_price_minor',
  'discount_minor',
  'line_total_minor',
] as const;

export const EXPORT_HEADER = EXPORT_COLUMNS.join(',') + CSV_EOL;

/** RFC 4180: quote when the cell holds a comma, a double quote, CR or LF; inner quotes are doubled. */
export function encodeCell(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A cell beginning with `= + - @ TAB CR` gets one leading apostrophe so spreadsheets do not run it. */
export function neutraliseFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

const guarded = (text: string | null): string =>
  encodeCell(neutraliseFormula(text ?? ''));

export function encodeRecord(row: ExportRow): string {
  return (
    [
      encodeCell(row.orderId),
      encodeCell(row.shopOrderId),
      row.createdAt.toISOString(),
      encodeCell(row.shopOrderStatus),
      encodeCell(row.currency),
      encodeCell(row.productId),
      guarded(row.sku),
      guarded(row.title),
      String(row.quantity),
      row.unitPriceMinor,
      row.discountMinor,
      row.lineTotalMinor,
    ].join(',') + CSV_EOL
  );
}
